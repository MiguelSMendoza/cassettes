import { it, expect, vi, afterEach } from "vitest";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
vi.mock("../src/server/tools", () => ({ runYt: vi.fn() }));
import { runYt } from "../src/server/tools";
import { Catalog } from "../src/server/db";
import { YouTube } from "../src/server/youtube";
afterEach(() => vi.unstubAllEnvs());
it("previsualizar y cancelar no muta catálogo; confirmar preserva ocurrencias", async () => {
  vi.stubEnv("YOUTUBE_API_KEY", "");
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-list-"));
  const c = new Catalog(dir);
  c.setRoot(dir);
  try {
    vi.mocked(runYt).mockResolvedValueOnce(
      JSON.stringify({
        id: "PL123456789",
        title: "Lista de prueba",
        entries: [
          { id: "BaW_jenozKc", title: "Uno", duration: 60 },
          { id: "BaW_jenozKc", title: "Uno", duration: 60 },
          { id: "aqz-KE-bpKQ", title: "Dos", duration: 100 },
        ],
      }),
    );
    const yt = new YouTube(c, 4310);
    const p = await yt.previewPlaylist(
      "https://youtube.com/playlist?list=PL123456789",
      false,
    );
    expect(p.items).toHaveLength(3);
    expect(c.tracks()).toHaveLength(0);
    expect(c.playlists()).toHaveLength(0);
    const committed = await yt.downloadPlaylist(p.id, {
      playlist: async (list: import("../src/domain/types").Playlist) => {
        c.savePlaylist(list, null);
        return list;
      },
    } as import("../src/server/downloads").Downloads);
    expect(committed.name).toBe("Lista de prueba");
    expect(committed.origin).toEqual({
      kind: "youtube",
      playlistId: "PL123456789",
      url: "https://www.youtube.com/playlist?list=PL123456789",
    });
    expect(c.playlists()[0]).toEqual(committed);
    expect(c.tracks()).toHaveLength(0);
    expect(committed.items[0]?.videoId).toBe("BaW_jenozKc");
    expect(committed.items[0]?.trackId).toBeNull();
    expect(committed.items[0]?.trackId).toBe(committed.items[1]?.trackId);
    expect(committed.items[0]?.id).not.toBe(committed.items[1]?.id);
  } finally {
    c.close();
  }
});
it("reiniciar sin tokens elimina datos privados recientes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-private-"));
  let c = new Catalog(dir);
  c.setRoot(dir);
  c.db
    .prepare("INSERT INTO tracks(id,title) VALUES(?,?)")
    .run("t", "TÍTULO PRIVADO");
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
      "private-account",
    );
  c.savePlaylist(
    {
      id: "p",
      name: "LISTA PRIVADA",
      private: true,
      partial: false,
      items: [{ id: "e", trackId: "t", title: "TÍTULO PRIVADO" }],
    },
    "private-account",
  );
  c.close();
  c = new Catalog(dir);
  try {
    expect(c.playlists()).toHaveLength(0);
    expect(c.tracks()).toHaveLength(0);
    expect(c.source("s")).toBeUndefined();
  } finally {
    c.close();
  }
});
it("la consulta de cola no pierde pendientes anteriores a los últimos 200", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-jobs-"));
  const c = new Catalog(dir);
  try {
    for (let i = 0; i < 210; i++)
      c.saveJob({
        id: String(i),
        url: "https://youtube.com/watch?v=BaW_jenozKc",
        videoId: "BaW_jenozKc",
        status: "queued",
        progress: 0,
        title: "Prueba",
        error: null,
        sourceId: null,
      });
    expect(c.jobs()).toHaveLength(210);
    expect(c.jobs().find((j) => j.id === "0")).toBeDefined();
  } finally {
    c.close();
  }
});
