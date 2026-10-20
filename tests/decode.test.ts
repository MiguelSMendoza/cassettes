import { it, expect, vi, afterEach } from "vitest";
import { decodeLocalAudio } from "../src/playback/decode";
afterEach(() => vi.unstubAllGlobals());
it("un formato rechazado por Web Audio se decodifica por la vía compatible con identidad y cancelación", async () => {
  const buffer = { length: 44100, sampleRate: 44100 } as AudioBuffer;
  const context = {
    decodeAudioData: vi
      .fn()
      .mockRejectedValueOnce(new Error("Unable to decode audio data"))
      .mockResolvedValueOnce(buffer),
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(new Uint8Array([1])))
    .mockResolvedValueOnce(
      new Response(new Uint8Array([2]), {
        headers: { "X-Cassettes-Audio-Warnings": "1" },
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const recovered = vi.fn();
  const signal = new AbortController().signal;
  expect(
    await decodeLocalAudio(context, "id", "Canción", "hash", signal, recovered),
  ).toBe(buffer);
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
    sourceId: "id",
    revision: "hash",
  });
  expect(fetch.mock.calls[1]![1].signal).toBe(signal);
  expect(recovered).toHaveBeenCalledWith(true);
});
it("si no se puede recuperar, identifica la canción; no intenta convertir errores HTTP ni cancelaciones", async () => {
  const context = {
    decodeAudioData: vi.fn().mockRejectedValue(new Error("bad")),
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(new Uint8Array([1])))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Audio ilegible" }), {
        status: 400,
      }),
    );
  vi.stubGlobal("fetch", fetch);
  await expect(
    decodeLocalAudio(context, "id", "Mi canción", "r"),
  ).rejects.toThrow("Mi canción");
  fetch.mockReset().mockResolvedValue(new Response("Ausente", { status: 404 }));
  await expect(decodeLocalAudio(context, "id", "Ausente", "r")).rejects.toThrow(
    "Ausente",
  );
  expect(fetch).toHaveBeenCalledTimes(1);
  const controller = new AbortController();
  controller.abort();
  fetch.mockReset();
  await expect(
    decodeLocalAudio(context, "id", "Cancelada", "r", controller.signal),
  ).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});
