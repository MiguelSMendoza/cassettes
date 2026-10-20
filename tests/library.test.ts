import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  symlink,
  readFile,
  unlink,
  rename,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app";
import { confined } from "../src/server/files";
import type { Snapshot } from "../src/domain/types";
function wav(seconds = 1) {
  const samples = 8000 * seconds;
  const b = Buffer.alloc(44 + samples * 2);
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
  b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    b.writeInt16LE(Math.round(Math.sin(i / 8) * 300), 44 + i * 2);
  return b;
}
let ctx: Awaited<ReturnType<typeof createApp>>;
let dir: string;
let root: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-test-"));
  ctx = await createApp({ dataDir: dir, watch: false });
  root = ctx.catalog.root().path;
});
afterEach(async () => {
  await ctx.app.close();
});
const headers = { "x-cassettes-client": "local" };
describe("biblioteca real y disco", () => {
  it("indexa en origen, conserva nombres sin etiquetas y agrupa copias exactas", async () => {
    await writeFile(path.join(root, "original.wav"), wav());
    await mkdir(path.join(root, "album"));
    await copyFile(
      path.join(root, "original.wav"),
      path.join(root, "album", "copia.WAV"),
    );
    await ctx.library.scan();
    const tracks = ctx.catalog.tracks();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]?.title).toBeTruthy();
    expect(tracks[0]?.artist).toBe("");
    expect(tracks[0]?.genres).toEqual([]);
    expect(tracks[0]?.sources[0]?.durationMs).toBe(1000);
    expect(tracks[0]?.sources[0]?.locations).toHaveLength(2);
    expect(await readFile(path.join(root, "original.wav"))).toEqual(wav());
  });
  it("confirma renombrado sin perder identidad y papelera restaura sin sobreescribir", async () => {
    await writeFile(path.join(root, "uno.wav"), wav());
    await ctx.library.scan();
    const source = ctx.catalog.tracks()[0]!.sources[0]!;
    const loc = source.locations[0]!;
    const op = await ctx.library.preview(loc.id, "rename", "dos.wav");
    expect(await readFile(path.join(root, "uno.wav"))).toEqual(wav());
    await ctx.library.apply(op.id);
    expect(ctx.catalog.tracks()[0]?.sources[0]?.id).toBe(source.id);
    expect(ctx.catalog.location(loc.id)?.relative_path).toBe("dos.wav");
    expect((await ctx.library.apply(op.id)).status).toBe("committed");
    const trash = await ctx.library.preview(loc.id, "trash");
    await ctx.library.apply(trash.id);
    expect(ctx.catalog.tracks()[0]?.sources[0]?.available).toBe(false);
    await writeFile(path.join(root, "dos.wav"), wav(2));
    await expect(ctx.library.preview(loc.id, "restore")).rejects.toThrow(
      "Ya existe",
    );
    await unlink(path.join(root, "dos.wav"));
    const restore = await ctx.library.preview(loc.id, "restore");
    await ctx.library.apply(restore.id);
    expect(ctx.catalog.tracks()[0]?.sources[0]?.available).toBe(true);
  });
  it("no renombra si el contenido cambió tras previsualizar y conserva extensión", async () => {
    await writeFile(path.join(root, "uno.wav"), wav());
    await ctx.library.scan();
    const loc = ctx.catalog.tracks()[0]!.sources[0]!.locations[0]!;
    await expect(
      ctx.library.preview(loc.id, "rename", "falso.mp3"),
    ).rejects.toThrow("extensión");
    const op = await ctx.library.preview(loc.id, "rename", "dos.wav");
    await writeFile(path.join(root, "uno.wav"), wav(2));
    await expect(ctx.library.apply(op.id)).rejects.toThrow("cambiado");
  });
  it("no sigue symlinks ni permite traversal y conserva catálogo si se desconecta raíz", async () => {
    await writeFile(path.join(root, "a.wav"), wav());
    await writeFile(path.join(dir, "fuera.wav"), wav(2));
    await symlink(path.join(dir, "fuera.wav"), path.join(root, "enlace.wav"));
    await ctx.library.scan();
    expect(ctx.catalog.tracks()).toHaveLength(1);
    await expect(confined(root, "../fuera.wav")).rejects.toThrow();
    await expect(confined(root, "enlace.wav")).rejects.toThrow("simbólicos");
    await rename(root, `${root}-offline`);
    await ctx.library.scan();
    expect(ctx.catalog.tracks()).toHaveLength(1);
    expect(ctx.library.scanState.errors.join(" ")).toContain("desconectada");
    expect(ctx.catalog.tracks()[0]!.sources[0]!.available).toBe(false);
    await rename(`${root}-offline`, root);
    await ctx.library.scan();
    expect(ctx.catalog.tracks()[0]!.sources[0]!.available).toBe(true);
  });
  it("una copia retirada no retira las demás; exclusión de canción persiste", async () => {
    await writeFile(path.join(root, "a.wav"), wav());
    await writeFile(path.join(root, "b.wav"), wav());
    await ctx.library.scan();
    const t = ctx.catalog.tracks()[0]!;
    const op = await ctx.library.preview(
      t.sources[0]!.locations[0]!.id,
      "trash",
    );
    await ctx.library.apply(op.id);
    await ctx.library.scan();
    expect(ctx.catalog.tracks()[0]?.sources[0]?.available).toBe(true);
    await ctx.app.inject({
      method: "POST",
      url: "/api/tracks/visibility",
      headers,
      payload: { ids: [t.id], hidden: true },
    });
    await writeFile(path.join(root, "otra.wav"), wav());
    await ctx.library.scan();
    expect(ctx.catalog.tracks()).toHaveLength(0);
    expect(ctx.catalog.tracks(true)).toHaveLength(1);
  });
  it("bloquea mutaciones de un activo en sesión y libera con stop", async () => {
    await writeFile(path.join(root, "a.wav"), wav());
    await ctx.library.scan();
    const t = ctx.catalog.tracks()[0]!,
      s = t.sources[0]!;
    const res = await ctx.app.inject({
      method: "POST",
      url: "/api/session/start",
      headers,
      payload: {
        tracks: [
          {
            id: "1",
            trackId: t.id,
            sourceId: s.id,
            revision: s.revision,
            durationMs: s.durationMs,
            title: t.title,
            artist: "",
            kind: "local",
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    await expect(
      ctx.library.preview(s.locations[0]!.id, "trash"),
    ).rejects.toThrow("sesión");
    await ctx.app.inject({
      method: "POST",
      url: "/api/session/stop",
      headers,
      payload: { id: res.json().id },
    });
    expect(
      (await ctx.library.preview(s.locations[0]!.id, "trash")).status,
    ).toBe("planned");
  });
  it("recupera diario tras cambio en disco antes de commit SQLite", async () => {
    await writeFile(path.join(root, "a.wav"), wav());
    await ctx.library.scan();
    const loc = ctx.catalog.tracks()[0]!.sources[0]!.locations[0]!;
    const op = await ctx.library.preview(loc.id, "rename", "b.wav");
    await rename(path.join(root, "a.wav"), path.join(root, "b.wav"));
    op.status = "filesystemApplied";
    ctx.catalog.saveOperation(op);
    await ctx.library.recover();
    expect(ctx.catalog.location(loc.id)?.relative_path).toBe("b.wav");
    expect(ctx.catalog.operations()[0]?.status).toBe("committed");
  });
});
describe("API y copias", () => {
  it("impide escrituras desde otros orígenes, sin cabecera local o host ajeno", async () => {
    for (const h of [
      { origin: "https://evil.example", ...headers },
      {},
      { host: "evil.example", ...headers },
    ]) {
      const r = await ctx.app.inject({
        method: "POST",
        url: "/api/scan",
        headers: h,
        payload: {},
      });
      expect(r.statusCode).toBe(403);
    }
  });
  it("sirve audio por ID y rango, nunca ruta libre", async () => {
    await writeFile(path.join(root, "a.wav"), wav());
    await ctx.library.scan();
    const id = ctx.catalog.tracks()[0]!.sources[0]!.id;
    const r = await ctx.app.inject({
      url: `/api/audio/${id}`,
      headers: { range: "bytes=0-43" },
    });
    expect(r.statusCode).toBe(206);
    expect(r.rawPayload.length).toBe(44);
    expect(r.headers["content-type"]).toContain("audio/wav");
    expect(
      (await ctx.app.inject({ url: "/api/audio/unknown" })).statusCode,
    ).toBe(404);
  });
  it("exportación válida no contiene credenciales y el estado es persistente", async () => {
    await writeFile(path.join(root, "a.wav"), wav());
    await ctx.library.scan();
    const r = await ctx.app.inject("/api/export");
    expect(r.json().format).toBe("cassettes");
    expect(r.body).not.toContain("access_token");
    const state = (await ctx.app.inject("/api/state")).json<Snapshot>();
    expect(state.tracks).toHaveLength(1);
    expect(ctx.catalog.db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
  it("restaurar copia anterior no revive fuentes privadas de YouTube", async () => {
    const id = "privado";
    ctx.catalog.db
      .prepare("INSERT INTO tracks(id,title) VALUES(?,?)")
      .run(id, "TÍTULO PRIVADO");
    ctx.catalog.db
      .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        "privsource",
        id,
        "youtube",
        "BaW_jenozKc",
        1000,
        "1000",
        "{}",
        Date.now(),
        "cuenta",
      );
    const backup = (await ctx.app.inject("/api/export")).json();
    expect(JSON.stringify(backup)).not.toContain("TÍTULO PRIVADO");
    const raw = {
      format: "cassettes",
      version: 1,
      tracks: [
        {
          id: "restoredprivate",
          title: "TÍTULO PRIVADO",
          artist: "",
          album: "",
          genres: [],
          hidden: false,
          sources: [
            {
              id: "oldprivate",
              kind: "youtube",
              videoId: "BaW_jenozKc",
              durationMs: 1000,
              revision: "1000",
              locations: [],
            },
          ],
        },
      ],
      plans: [],
    };
    const preview = await ctx.app.inject({
      method: "POST",
      url: "/api/restore/preview",
      headers,
      payload: raw,
    });
    expect(preview.statusCode).toBe(200);
    await ctx.app.inject({
      method: "POST",
      url: "/api/restore/confirm",
      headers,
      payload: { id: preview.json().id },
    });
    expect(ctx.catalog.tracks().some((t) => t.id === "restoredprivate")).toBe(
      false,
    );
  });
});

it("la copia con audio conserva papelera y permite restaurar en una raíz nueva", async () => {
  await writeFile(path.join(root, "recuperable.wav"), wav());
  await ctx.library.scan();
  const original = ctx.catalog.tracks()[0]!.sources[0]!.locations[0]!;
  const op = await ctx.library.preview(original.id, "trash");
  await ctx.library.apply(op.id);
  const backup = await ctx.app.inject({
    method: "POST",
    url: "/api/backup",
    headers,
    payload: {},
  });
  expect(backup.statusCode).toBe(200);
  const backupPath = backup.json().path as string;
  const { cp } = await import("node:fs/promises");
  const target = path.join(dir, "restored-music");
  await cp(path.join(backupPath, "music"), target, { recursive: true });
  const restored = await createApp({
    dataDir: path.join(dir, "restored-app"),
    watch: false,
  });
  try {
    restored.catalog.setRoot(target);
    const payload = JSON.parse(
      await readFile(path.join(backupPath, "catalog.json"), "utf8"),
    ) as unknown;
    const preview = await restored.app.inject({
      method: "POST",
      url: "/api/restore/preview",
      headers: { ...headers, "content-type": "application/json" },
      payload: JSON.stringify(payload),
    });
    expect(preview.statusCode).toBe(200);
    const applied = await restored.app.inject({
      method: "POST",
      url: "/api/restore/confirm",
      headers,
      payload: { id: preview.json().id },
    });
    expect(applied.statusCode).toBe(200);
    const loc = restored.catalog.tracks()[0]!.sources[0]!.locations[0]!;
    expect(loc.trashed).toBe(true);
    const recover = await restored.library.preview(loc.id, "restore");
    await restored.library.apply(recover.id);
    expect(await readFile(path.join(target, "recuperable.wav"))).toEqual(wav());
  } finally {
    await restored.app.close();
  }
});

it("bloquea sesiones y cambios de raíz mientras se prepara una sesión o una operación", async () => {
  ctx.library.lockedSources.add("preparing-source");
  const session = await ctx.app.inject({
    method: "POST",
    url: "/api/session/start",
    headers,
    payload: { tracks: [] },
  });
  expect(session.statusCode).toBe(400);
  expect(session.json().error).toContain("sesión activa");
  ctx.library.lockedSources.clear();
  ctx.library.mutating = true;
  await expect(ctx.library.chooseRoot(root)).rejects.toThrow(
    "operación actual",
  );
  const backup = await ctx.app.inject({
    method: "POST",
    url: "/api/backup",
    headers,
    payload: {},
  });
  expect(backup.statusCode).toBe(400);
  ctx.library.mutating = false;
});
