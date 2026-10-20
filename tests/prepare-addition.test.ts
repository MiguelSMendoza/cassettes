import { it, expect, vi, afterEach } from "vitest";
import { prepareTrackAddition } from "../src/playback/prepare-addition";
import { buildPlan } from "../src/domain/planner";
import { defaultConfig, type Track } from "../src/domain/types";
afterEach(() => vi.unstubAllGlobals());
it("avisa de errores recuperables al añadir audio compatible en memoria", async () => {
  const decode = vi
    .fn()
    .mockRejectedValueOnce(new Error("codec"))
    .mockResolvedValueOnce({ length: 1000, sampleRate: 1000 });
  vi.stubGlobal(
    "AudioContext",
    class {
      decodeAudioData = decode;
      close = vi.fn().mockResolvedValue(undefined);
    },
  );
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([1])))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([2]), {
          headers: { "X-Cassettes-Audio-Warnings": "1" },
        }),
      ),
  );
  const p = buildPlan([], defaultConfig);
  p.sides = [
    {
      id: "1A",
      tape: 1,
      face: "A",
      tracks: [],
      programMs: 0,
      occupiedMs: 0,
      freeMs: 1800000,
    },
  ];
  const recovered = vi.fn();
  const next = await prepareTrackAddition(
    p,
    "1A",
    track,
    new AbortController().signal,
    undefined,
    recovered,
  );
  expect(recovered).toHaveBeenCalledWith(true);
  expect(next.sides[0]?.tracks).toHaveLength(1);
});
const track: Track = {
  id: "t",
  title: "Nueva",
  artist: "Artista",
  album: "",
  genres: [],
  disc: null,
  trackNumber: null,
  hidden: false,
  sources: [
    {
      id: "s",
      trackId: "t",
      kind: "local",
      durationMs: 1000,
      revision: "r",
      locations: [],
      available: true,
    },
  ],
};
it("añadir mide el audio y guarda su revisión solo después de comprobar que cabe", async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal(
    "AudioContext",
    class {
      decodeAudioData = vi
        .fn()
        .mockResolvedValue({ length: 1001, sampleRate: 1000 });
      close = close;
    },
  );
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(new Uint8Array([1])))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ revision: "updated" })),
    );
  vi.stubGlobal("fetch", fetch);
  const p = buildPlan([], defaultConfig);
  p.sides = [
    {
      id: "1A",
      tape: 1,
      face: "A",
      tracks: [],
      programMs: 0,
      occupiedMs: 0,
      freeMs: 1800000,
    },
  ];
  const next = await prepareTrackAddition(
    p,
    "1A",
    track,
    new AbortController().signal,
  );
  expect(next.sides[0]?.tracks[0]).toMatchObject({
    durationMs: 1001,
    revision: "updated",
    trackId: "t",
  });
  expect(fetch.mock.calls[1]?.[0]).toBe("/api/sources/duration");
  expect(close).toHaveBeenCalledOnce();
  expect(p.sides[0]?.tracks).toHaveLength(0);
});
it("una canción que no cabe no actualiza el catálogo ni cambia el plan y cierra el contexto", async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal(
    "AudioContext",
    class {
      decodeAudioData = vi
        .fn()
        .mockResolvedValue({ length: 1800000, sampleRate: 1000 });
      close = close;
    },
  );
  const fetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1])));
  vi.stubGlobal("fetch", fetch);
  const p = buildPlan([], defaultConfig);
  p.sides = [
    {
      id: "1A",
      tape: 1,
      face: "A",
      tracks: [],
      programMs: 0,
      occupiedMs: 0,
      freeMs: 1800000,
    },
  ];
  const before = JSON.stringify(p);
  await expect(
    prepareTrackAddition(p, "1A", track, new AbortController().signal),
  ).rejects.toThrow("no cabe");
  expect(fetch).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
  expect(JSON.stringify(p)).toBe(before);
  const controller = new AbortController();
  controller.abort();
  fetch.mockClear();
  await expect(
    prepareTrackAddition(p, "1A", track, controller.signal),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
