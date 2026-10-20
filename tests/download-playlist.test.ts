import { it, expect, vi } from "vitest";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
vi.mock("../src/server/tools", async (original) => ({
  ...(await original<typeof import("../src/server/tools")>()),
  hasDownloader: () => true,
  runYt: vi.fn(),
}));
import { runYt } from "../src/server/tools";
import { createApp } from "../src/server/app";

it("confirmar una lista descarga MP3, preserva orden y repeticiones y enlaza solo fuentes locales", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-mp3-list-"));
  const ctx = await createApp({ dataDir: dir, watch: false });
  const h = { "x-cassettes-client": "local" };
  vi.mocked(runYt).mockImplementation(async (args) => {
    if (args.includes("--flat-playlist"))
      return JSON.stringify({
        id: "PL123456789",
        title: "Mi lista YouTube",
        entries: [
          { id: "BaW_jenozKc", title: "Uno", duration: 2 },
          { id: "aqz-KE-bpKQ", title: "Dos", duration: 3 },
          { id: "BaW_jenozKc", title: "Uno", duration: 2 },
        ],
      });
    const output = args[args.indexOf("-o") + 1]!.replace("%(ext)s", "mp3");
    await writeFile(output, Buffer.from(args.at(-1)!));
    await writeFile(
      path.join(path.dirname(output), "audio.info.json"),
      JSON.stringify({ title: "Descargada" }),
    );
    return "";
  });
  // El proveedor de audio está simulado; sí se verifican cola, disco y asociaciones persistentes.
  vi.spyOn(ctx.library, "indexFile").mockImplementation(
    async (_file, rootId, relativePath, knownTrack) => {
      const id = crypto.randomUUID(),
        trackId = knownTrack ?? crypto.randomUUID();
      ctx.catalog.db
        .prepare("INSERT OR IGNORE INTO tracks(id,title) VALUES(?,?)")
        .run(trackId, "Descargada");
      ctx.catalog.db
        .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id, trackId, "local", id, 2000, "r", "{}", Date.now(), null);
      ctx.catalog.db
        .prepare("INSERT INTO locations VALUES(?,?,?,?,?,?,?,?,?)")
        .run(crypto.randomUUID(), id, rootId, relativePath, 12, 1, 1, 0, null);
      return id;
    },
  );
  try {
    const draft = await ctx.app.inject({
      method: "POST",
      url: "/api/playlists/preview",
      headers: h,
      payload: { url: "https://youtube.com/playlist?list=PL123456789" },
    });
    expect(draft.statusCode).toBe(200);
    const response = await ctx.app.inject({
      method: "POST",
      url: "/api/playlists/confirm",
      headers: h,
      payload: { id: draft.json().id },
    });
    expect(response.statusCode).toBe(200);
    const deadline = Date.now() + 3000;
    while (
      ctx.catalog
        .jobs()
        .some((j) => ["queued", "running"].includes(j.status)) &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 10));
    const state = (await ctx.app.inject({ url: "/api/state" })).json();
    expect(state.playlists[0].name).toBe("Mi lista YouTube");
    const items = state.playlists[0].items;
    expect(items).toHaveLength(3);
    expect(items[0].trackId).toBeTruthy();
    expect(items[0].trackId).toBe(items[2].trackId);
    expect(items[0].id).not.toBe(items[2].id);
    expect(ctx.catalog.jobs()).toHaveLength(2);
    expect(
      ctx.catalog
        .tracks()
        .flatMap((t) => t.sources)
        .every((s) => s.kind === "local"),
    ).toBe(true);
    ctx.catalog.db.prepare("UPDATE playlists SET fetched_at=0").run();
    ctx.catalog.expire();
    expect(ctx.catalog.playlists()).toHaveLength(1);
    const files = ctx.catalog
      .tracks()
      .flatMap((t) =>
        t.sources.flatMap((s) =>
          s.locations.flatMap((l) => (l.absolutePath ? [l.absolutePath] : [])),
        ),
      );
    const bytesBefore = await Promise.all(files.map((file) => readFile(file)));
    const renamed = await ctx.app.inject({
      method: "POST",
      url: "/api/playlists/rename",
      headers: h,
      payload: { id: state.playlists[0].id, name: "Nuevo nombre" },
    });
    expect(renamed.json().name).toBe("Nuevo nombre");
    const removed = await ctx.app.inject({
      method: "POST",
      url: "/api/playlists/delete",
      headers: h,
      payload: { id: state.playlists[0].id },
    });
    expect(removed.statusCode).toBe(200);
    expect(ctx.catalog.playlists()).toHaveLength(0);
    expect(ctx.catalog.tracks()).toHaveLength(2);
    expect(await Promise.all(files.map((file) => readFile(file)))).toEqual(
      bytesBefore,
    );
  } finally {
    await ctx.app.close();
  }
});

it("un fallo queda visible, reintentar enlaza el nuevo trabajo y no duplica la ocurrencia", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-mp3-retry-"));
  const ctx = await createApp({ dataDir: dir, watch: false });
  try {
    vi.mocked(runYt).mockRejectedValue(new Error("Vídeo no disponible"));
    const p = {
      id: "p",
      name: "Lista",
      origin: {
        kind: "youtube" as const,
        playlistId: "PL123456789",
        url: "https://youtube.com/playlist?list=PL123456789",
      },
      private: false,
      partial: false,
      items: [
        {
          id: "occurrence",
          title: "Una canción",
          trackId: null,
          videoId: "BaW_jenozKc",
        },
      ],
    };
    await ctx.downloads.playlist(p);
    const until = Date.now() + 2000;
    while (
      ctx.catalog
        .jobs()
        .some((j) => ["queued", "running"].includes(j.status)) &&
      Date.now() < until
    )
      await new Promise((r) => setTimeout(r, 10));
    const first = ctx.catalog.playlists()[0]!.items[0]!;
    expect(
      ctx.catalog.jobs().find((j) => j.id === first.downloadJobId)?.status,
    ).toBe("failed");
    expect(first.trackId).toBeNull();
    await ctx.downloads.playlist(ctx.catalog.playlists()[0]!);
    const retry = ctx.catalog.playlists()[0]!.items[0]!;
    expect(retry.downloadJobId).not.toBe(first.downloadJobId);
    expect(retry.id).toBe(first.id);
    expect(ctx.catalog.playlists()[0]!.items).toHaveLength(1);
  } finally {
    await ctx.app.close();
  }
});

it("los enlaces sueltos solo encolan MP3 y el servidor rechaza reproducción remota heredada", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-local-only-"));
  const ctx = await createApp({ dataDir: dir, watch: false });
  const headers = { "x-cassettes-client": "local" };
  try {
    vi.mocked(runYt).mockRejectedValue(new Error("Prueba sin red"));
    const r = await ctx.app.inject({
      method: "POST",
      url: "/api/youtube/import",
      headers,
      payload: { urls: ["https://youtube.com/watch?v=BaW_jenozKc"] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().jobs).toHaveLength(1);
    expect(ctx.catalog.tracks()).toHaveLength(0);
    const playback = await ctx.app.inject({
      method: "POST",
      url: "/api/session/start",
      headers,
      payload: {
        tracks: [
          {
            id: "t",
            trackId: "t",
            sourceId: "s",
            revision: "r",
            title: "Remota",
            artist: "",
            kind: "youtube",
            durationMs: 1000,
            videoId: "BaW_jenozKc",
          },
        ],
      },
    });
    expect(playback.statusCode).toBe(400);
    expect(playback.json().error).toContain("MP3");
  } finally {
    await ctx.app.close();
  }
});
