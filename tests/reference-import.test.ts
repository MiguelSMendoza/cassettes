import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mkdtemp,
  realpath,
  mkdir,
  writeFile,
  readFile,
  readdir,
  stat,
  unlink,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app";
import { Catalog } from "../src/server/db";
const headers = { "x-cassettes-client": "local" };
function wav(seconds: number) {
  const b = Buffer.alloc(44 + 8000 * seconds * 2);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(b.length - 44, 40);
  return b;
}
let ctx: Awaited<ReturnType<typeof createApp>>;
let dir: string;
beforeEach(async () => {
  dir = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "cassettes-reference-")),
  );
  ctx = await createApp({ dataDir: path.join(dir, "app"), watch: false });
});
afterEach(async () => {
  await ctx.app.close();
});
async function add(paths: string[]) {
  const preview = await ctx.app.inject({
    method: "POST",
    url: "/api/files/import/preview",
    headers,
    payload: { paths },
  });
  expect(preview.statusCode, preview.body).toBe(200);
  const result = await ctx.app.inject({
    method: "POST",
    url: "/api/files/import",
    headers,
    payload: { id: preview.json().id },
  });
  expect(result.statusCode, result.body).toBe(200);
  // El escaneo se inicia en segundo plano, igual que desde la interfaz.
  const deadline = Date.now() + 5000;
  while (ctx.library.scanState.running && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 5));
  expect(ctx.library.scanState.running).toBe(false);
}
it("añade archivos sueltos y varias carpetas sin copiar, sin indexar vecinos y reproduce bytes originales", async () => {
  const folder = path.join(dir, "colección"),
    singles = path.join(dir, "sueltos");
  await mkdir(path.join(folder, "álbum"), { recursive: true });
  await mkdir(singles);
  const a = path.join(folder, "álbum", "A.wav"),
    b = path.join(singles, "B.wav"),
    neighbor = path.join(singles, "NO IMPORTAR.wav");
  await writeFile(a, wav(1));
  await writeFile(b, wav(2));
  await writeFile(neighbor, wav(3));
  const before = await stat(b);
  const preview = await ctx.app.inject({
    method: "POST",
    url: "/api/files/import/preview",
    headers,
    payload: { paths: [folder, b] },
  });
  expect(preview.statusCode).toBe(200);
  expect(ctx.catalog.tracks()).toHaveLength(0);
  await add([folder, b]);
  expect(ctx.catalog.tracks()).toHaveLength(2);
  expect(await readdir(ctx.catalog.root().path)).toEqual([]);
  expect((await stat(b)).ino).toBe(before.ino);
  for (const track of ctx.catalog.tracks()) {
    const source = track.sources[0]!;
    expect(source.available).toBe(true);
    const { file } = await ctx.library.sourceFile(source.id);
    expect([a, b]).toContain(file);
    const response = await ctx.app.inject({
      method: "GET",
      url: `/api/audio/${source.id}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(await readFile(file));
  }
  const restored = new Catalog(ctx.catalog.dataDir);
  try {
    expect(restored.entries().map((e) => e.path)).toEqual(
      expect.arrayContaining([folder, b]),
    );
    expect(restored.tracks()).toHaveLength(2);
  } finally {
    restored.close();
  }
  await add([folder, b, path.join(folder, "álbum"), a]);
  expect(ctx.catalog.locations()).toHaveLength(2);
});
it("detecta cambios y nuevos archivos solo en carpetas incluidas, conserva originales al renombrar y retirar", async () => {
  const folder = path.join(dir, "musica"),
    singles = path.join(dir, "archivos");
  await mkdir(folder);
  await mkdir(singles);
  const solo = path.join(singles, "original.wav");
  await writeFile(solo, wav(1));
  await add([folder, solo]);
  const loc = ctx.catalog.locations()[0]!;
  const rename = await ctx.library.preview(loc.id, "rename", "renombrado.wav");
  await ctx.library.apply(rename.id);
  expect(ctx.catalog.entries().map((e) => e.path)).toContain(
    path.join(singles, "renombrado.wav"),
  );
  await ctx.library.scan();
  expect(ctx.catalog.tracks()[0]!.sources[0]!.available).toBe(true);
  await writeFile(path.join(folder, "nueva.wav"), wav(2));
  await writeFile(path.join(singles, "vecina.wav"), wav(3));
  await ctx.library.scan();
  expect(ctx.catalog.tracks()).toHaveLength(2);
  const trash = await ctx.library.preview(loc.id, "trash");
  await ctx.library.apply(trash.id);
  await ctx.library.scan();
  expect(ctx.catalog.location(loc.id)!.trashed).toBe(1);
  const restore = await ctx.library.preview(loc.id, "restore");
  await ctx.library.apply(restore.id);
  expect(await readFile(path.join(singles, "renombrado.wav"))).toEqual(wav(1));
  await unlink(path.join(singles, "renombrado.wav"));
  await ctx.library.scan();
  expect(ctx.catalog.location(loc.id)!.available).toBe(0);
});
it("rechaza subidas de audio y rutas no autorizadas, explora sin importar ni seguir enlaces", async () => {
  const folder = path.join(dir, "explorar");
  await mkdir(folder);
  await writeFile(path.join(folder, "a.wav"), wav(1));
  await symlink(path.join(folder, "a.wav"), path.join(folder, "link.wav"));
  const listing = await ctx.app.inject({
    method: "POST",
    url: "/api/files/browse",
    headers,
    payload: { path: folder },
  });
  expect(listing.statusCode).toBe(200);
  expect(listing.json().entries.map((e: { name: string }) => e.name)).toEqual([
    "a.wav",
  ]);
  expect(ctx.catalog.tracks()).toHaveLength(0);
  for (const input of [
    "relative.wav",
    os.homedir(),
    path.join(folder, "link.wav"),
  ]) {
    const result = await ctx.app.inject({
      method: "POST",
      url: "/api/files/import/preview",
      headers,
      payload: { paths: [input] },
    });
    expect(result.statusCode).toBe(400);
  }
  const foreign = await ctx.app.inject({
    method: "POST",
    url: "/api/files/browse",
    headers: { ...headers, origin: "https://example.com" },
    payload: { path: folder },
  });
  expect(foreign.statusCode).toBe(403);
  const upload = await ctx.app.inject({
    method: "POST",
    url: "/api/files/import",
    headers: {
      ...headers,
      "content-type": "multipart/form-data; boundary=test",
    },
    payload: "--test--",
  });
  expect(upload.statusCode).toBe(400);
});
it("migra un catálogo v1 sin perder referencias ni generar audio", async () => {
  const file = path.join(ctx.catalog.root().path, "anterior.wav");
  await writeFile(file, wav(1));
  await ctx.library.scan();
  ctx.catalog.db.exec(
    "DROP TABLE library_entries;DELETE FROM migrations WHERE version=2",
  );
  const migrated = new Catalog(ctx.catalog.dataDir);
  try {
    expect(migrated.tracks()).toHaveLength(1);
    expect(migrated.entries()[0]!.path).toBe(ctx.catalog.root().path);
    expect(
      migrated.db
        .prepare("SELECT version FROM migrations WHERE version=2")
        .get(),
    ).toBeTruthy();
    expect(await readdir(ctx.catalog.root().path)).toEqual(["anterior.wav"]);
  } finally {
    migrated.close();
  }
});

it("la copia explícita conserva varias raíces con nombres iguales y restaura sus archivos", async () => {
  const a = path.join(dir, "A"),
    b = path.join(dir, "B");
  await mkdir(a);
  await mkdir(b);
  await writeFile(path.join(a, "mismo.wav"), wav(1));
  await writeFile(path.join(b, "mismo.wav"), wav(2));
  await add([a, b]);
  const backup = await ctx.app.inject({
    method: "POST",
    url: "/api/backup",
    headers,
    payload: {},
  });
  expect(backup.statusCode, backup.body).toBe(200);
  const base = backup.json().path as string;
  const data = JSON.parse(
    await readFile(path.join(base, "catalog.json"), "utf8"),
  );
  const restored = await createApp({
    dataDir: path.join(dir, "restored"),
    watch: false,
  });
  try {
    restored.catalog.setRoot(path.join(base, "music"));
    const preview = await restored.app.inject({
      method: "POST",
      url: "/api/restore/preview",
      headers,
      payload: data,
    });
    expect(preview.statusCode, preview.body).toBe(200);
    const result = await restored.app.inject({
      method: "POST",
      url: "/api/restore/confirm",
      headers,
      payload: { id: preview.json().id },
    });
    expect(result.statusCode, result.body).toBe(200);
    const tracks = restored.catalog.tracks();
    expect(tracks).toHaveLength(2);
    for (const t of tracks) {
      const { file } = await restored.library.sourceFile(t.sources[0]!.id);
      expect([wav(1).length, wav(2).length]).toContain((await stat(file)).size);
    }
  } finally {
    await restored.app.close();
  }
});

it("un archivo publicado durante el escaneo no se marca ausente por no estar en la instantánea inicial", async () => {
  const root = ctx.catalog.root();
  const first = path.join(root.path, "Inicial.wav"),
    later = path.join(root.path, "Descarga nueva.wav");
  await writeFile(first, wav(1));
  await ctx.library.scan();
  const original = ctx.library.indexFile.bind(ctx.library);
  const spy = vi.spyOn(ctx.library, "indexFile");
  spy.mockImplementationOnce(async (...args) => {
    await writeFile(later, wav(2));
    await original(later, root.id, "Descarga nueva.wav");
    return original(...args);
  });
  try {
    await ctx.library.scan(true);
    const song = ctx.catalog
      .tracks()
      .find((t) => t.title === "Descarga nueva.wav");
    expect(song?.sources[0]?.available).toBe(true);
  } finally {
    spy.mockRestore();
  }
});
