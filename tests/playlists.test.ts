import { it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Catalog } from "../src/server/db";
import { Playlists } from "../src/server/playlists";

it("crea listas locales persistentes, evita repeticiones accidentales y valida canciones", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-playlists-"));
  let catalog = new Catalog(dir);
  const service = new Playlists(catalog);
  catalog.db
    .prepare("INSERT INTO tracks(id,title) VALUES(?,?)")
    .run("t", "Canción");
  const p = service.create("  Mi selección  ", ["t", "t"]);
  expect(p.name).toBe("Mi selección");
  expect(p.origin).toEqual({ kind: "local" });
  expect(p.items).toHaveLength(1);
  expect(service.add(p.id, ["t"]).items).toEqual(p.items);
  expect(() => service.add(p.id, ["inexistente"])).toThrow();
  expect(() => service.create("  ", [])).toThrow();
  catalog.db.prepare("UPDATE playlists SET fetched_at=0").run();
  catalog.close();
  catalog = new Catalog(dir);
  try {
    expect(catalog.playlists()).toEqual([p]);
    const updated = new Playlists(catalog).remove(p.id, p.items[0]!.id);
    expect(updated.items).toEqual([]);
    expect(catalog.tracks()).toHaveLength(1);
  } finally {
    catalog.close();
  }
});

it("la purga privada elimina también títulos privados referenciados desde listas locales", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "cassettes-playlist-private-"),
  );
  let c = new Catalog(dir);
  c.db.prepare("INSERT INTO tracks(id,title) VALUES(?,?)").run("t", "SECRETO");
  c.db
    .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)")
    .run(
      "s",
      "t",
      "youtube",
      "BaW_jenozKc",
      1000,
      "1000",
      "{}",
      Date.now(),
      "private",
    );
  new Playlists(c).create("Mi lista", ["t"]);
  c.close();
  c = new Catalog(dir);
  try {
    expect(c.playlists()).toHaveLength(1);
    expect(c.playlists()[0]?.items[0]?.trackId).toBeNull();
    expect(JSON.stringify(c.playlists())).not.toContain("SECRETO");
  } finally {
    c.close();
  }
});

it("la API crea y amplía listas, rechaza entradas inválidas y exporta sin títulos privados", async () => {
  const { createApp } = await import("../src/server/app");
  const { restoreSchema, restoreCatalog } =
    await import("../src/server/restore");
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-playlist-api-"));
  const ctx = await createApp({ dataDir: dir, watch: false });
  const headers = { "x-cassettes-client": "local" };
  try {
    ctx.catalog.db
      .prepare("INSERT INTO tracks(id,title) VALUES(?,?)")
      .run("private-track", "NO EXPORTAR");
    ctx.catalog.db
      .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)")
      .run(
        "s",
        "private-track",
        "youtube",
        "BaW_jenozKc",
        1000,
        "1000",
        "{}",
        Date.now(),
        "private",
      );
    const created = await ctx.app.inject({
      method: "POST",
      url: "/api/playlists/create",
      headers,
      payload: { name: "Mi lista", trackIds: [] },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id as string;
    const added = await ctx.app.inject({
      method: "POST",
      url: "/api/playlists/add",
      headers,
      payload: { id, trackIds: ["private-track", "private-track"] },
    });
    expect(added.statusCode).toBe(200);
    expect(added.json().items).toHaveLength(1);
    const invalid = await ctx.app.inject({
      method: "POST",
      url: "/api/playlists/create",
      headers,
      payload: { name: "   " },
    });
    expect(invalid.statusCode).toBe(400);
    const missing = await ctx.app.inject({
      method: "POST",
      url: "/api/playlists/add",
      headers,
      payload: { id, trackIds: ["not-found"] },
    });
    expect(missing.statusCode).toBe(400);
    expect(ctx.catalog.playlists()[0]?.items).toHaveLength(1);
    const exported = await ctx.app.inject({ url: "/api/export" });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain("NO EXPORTAR");
    const data = restoreSchema.parse(exported.json());
    expect(data.playlists[0]?.origin).toEqual({ kind: "local" });
    await restoreCatalog(ctx.catalog, ctx.library, ctx.youtube, data);
    expect(ctx.catalog.playlists()[0]?.origin).toEqual({ kind: "local" });
    expect(ctx.catalog.playlists()[0]?.items[0]?.trackId).toBeNull();
  } finally {
    await ctx.app.close();
  }
});

it("editar una lista importada mantiene procedencia, privacidad y fecha de caché", async () => {
  const dir = await mkdtemp(
    path.join(os.tmpdir(), "cassettes-playlist-origin-"),
  );
  const c = new Catalog(dir);
  try {
    c.db
      .prepare("INSERT INTO tracks(id,title) VALUES(?,?)")
      .run("t", "Canción local");
    const imported = {
      id: "p",
      name: "Lista original",
      origin: {
        kind: "youtube" as const,
        playlistId: "PL123456789",
        url: "https://www.youtube.com/playlist?list=PL123456789",
      },
      private: true,
      partial: false,
      items: [],
    };
    c.savePlaylist(imported, "private-account");
    const before = c.db
      .prepare("SELECT fetched_at,private_account FROM playlists WHERE id='p'")
      .get();
    const updated = new Playlists(c).add("p", ["t"]);
    expect(updated.name).toBe(imported.name);
    expect(updated.origin).toEqual(imported.origin);
    expect(updated.items).toHaveLength(1);
    expect(
      c.db
        .prepare(
          "SELECT fetched_at,private_account FROM playlists WHERE id='p'",
        )
        .get(),
    ).toEqual(before);
    c.expire(true);
    expect(c.playlists()).toEqual([]);
  } finally {
    c.close();
  }
});

it("caducar una referencia YouTube no reemplaza el título personal de su MP3 local", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-local-title-"));
  const c = new Catalog(dir);
  try {
    c.db
      .prepare("INSERT INTO tracks(id,title,artist) VALUES(?,?,?)")
      .run("t", "Mi archivo MP3", "Artista local");
    c.db
      .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)")
      .run("remote", "t", "youtube", "BaW_jenozKc", 1000, "r", "{}", 0, null);
    c.db
      .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)")
      .run("local", "t", "local", "hash", 1000, "h", "{}", Date.now(), null);
    c.expire();
    expect(c.tracks()[0]?.title).toBe("Mi archivo MP3");
    expect(c.tracks()[0]?.artist).toBe("Artista local");
  } finally {
    c.close();
  }
});
