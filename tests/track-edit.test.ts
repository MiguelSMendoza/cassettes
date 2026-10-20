import { it, expect } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApp } from "../src/server/app";
import { buildPlan } from "../src/domain/planner";
import { defaultConfig } from "../src/domain/types";
it("editar metadatos persiste en biblioteca, todas las ocurrencias guardadas y listas sin cambiar audio ni reparto", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-edit-"));
  let ctx = await createApp({ dataDir: dir, watch: false });
  const headers = { "x-cassettes-client": "local" };
  try {
    ctx.catalog.db
      .prepare("INSERT INTO tracks(id,title) VALUES(?,?)")
      .run("t", "Original");
    const plan = buildPlan(
      [1, 2].map((i) => ({
        id: String(i),
        trackId: "t",
        sourceId: "s",
        revision: "hash",
        kind: "local" as const,
        title: "Original",
        artist: "Antes",
        durationMs: 1000,
      })),
      defaultConfig,
    );
    ctx.catalog.savePlan(plan);
    const before = structuredClone(plan);
    ctx.catalog.savePlaylist(
      {
        id: "list",
        name: "Lista",
        private: false,
        partial: false,
        items: [
          { id: "one", trackId: "t", title: "Original" },
          { id: "two", trackId: null, title: "No tocar" },
        ],
      },
      null,
    );
    const result = await ctx.app.inject({
      method: "POST",
      url: "/api/tracks/edit",
      headers,
      payload: {
        id: "t",
        title: "Nuevo título",
        artist: "Artista",
        album: "Álbum",
        genres: ["Pop"],
      },
    });
    expect(result.statusCode).toBe(200);
    expect(ctx.catalog.playlists()[0]?.items.map((i) => i.title)).toEqual([
      "Nuevo título",
      "No tocar",
    ]);
    expect(ctx.catalog.tracks()[0]?.title).toBe("Nuevo título");
    const saved = ctx.catalog.plans()[0]!;
    for (const side of saved.sides)
      for (const t of side.tracks) {
        t.title = "Original";
        t.artist = "Antes";
      }
    expect(saved).toEqual(before);
    expect(
      ctx.catalog
        .plans()[0]
        ?.sides.flatMap((s) => s.tracks)
        .every((t) => t.title === "Nuevo título" && t.artist === "Artista"),
    ).toBe(true);
    await ctx.app.close();
    ctx = await createApp({ dataDir: dir, watch: false });
    expect(ctx.catalog.tracks()[0]?.title).toBe("Nuevo título");
    expect(
      ctx.catalog.plans()[0]?.sides.flatMap((s) => s.tracks)[0]?.title,
    ).toBe("Nuevo título");
    const missing = await ctx.app.inject({
      method: "POST",
      url: "/api/tracks/edit",
      headers,
      payload: { id: "missing", title: "X", artist: "", album: "", genres: [] },
    });
    expect(missing.statusCode).toBe(404);
    const empty = await ctx.app.inject({
      method: "POST",
      url: "/api/tracks/edit",
      headers,
      payload: { id: "t", title: "   ", artist: "", album: "", genres: [] },
    });
    expect(empty.statusCode).toBe(400);
    ctx.catalog.db.exec(
      "CREATE TRIGGER fail_plan_update BEFORE UPDATE ON plans BEGIN SELECT RAISE(ABORT, 'simulated failure'); END",
    );
    const failed = await ctx.app.inject({
      method: "POST",
      url: "/api/tracks/edit",
      headers,
      payload: {
        id: "t",
        title: "No debe persistir",
        artist: "",
        album: "",
        genres: [],
      },
    });
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect(
      ctx.catalog.plans()[0]?.sides.flatMap((s) => s.tracks)[0]?.title,
    ).toBe("Nuevo título");
    expect(ctx.catalog.playlists()[0]?.items[0]?.title).toBe("Nuevo título");
    expect(ctx.catalog.tracks()[0]?.title).toBe("Nuevo título");
  } finally {
    await ctx.app.close();
  }
});

it("las cintas antiguas muestran los metadatos actuales de biblioteca sin regenerar ni cambiar su audio", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-old-labels-"));
  const ctx = await createApp({ dataDir: dir, watch: false });
  try {
    ctx.catalog.db
      .prepare("INSERT INTO tracks(id,title,artist,overrides) VALUES(?,?,?,?)")
      .run(
        "t",
        "Archivo.mp3",
        "Antes",
        JSON.stringify({ title: "Quererte Bonito", artist: "Actual" }),
      );
    const plan = buildPlan(
      [
        {
          id: "entry",
          trackId: "t",
          sourceId: "s",
          revision: "hash",
          kind: "local",
          title: "Archivo.mp3",
          artist: "Antes",
          durationMs: 1000,
        },
      ],
      defaultConfig,
    );
    ctx.catalog.savePlan(plan);
    const state = await ctx.app.inject({ method: "GET", url: "/api/state" });
    const current = state.json().plans[0];
    expect(current.sides[0].tracks[0].title).toBe("Quererte Bonito");
    expect(current.sides[0].tracks[0].artist).toBe("Actual");
    current.sides[0].tracks[0].title = "Archivo.mp3";
    current.sides[0].tracks[0].artist = "Antes";
    expect(current).toEqual(plan);
  } finally {
    await ctx.app.close();
  }
});
