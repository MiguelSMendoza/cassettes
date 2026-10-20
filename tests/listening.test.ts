import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ListeningPlayer } from "../src/playback/listening";
import type { Track, Source } from "../src/domain/types";
const source: Source = {
  id: "local-a",
  trackId: "a",
  kind: "local",
  durationMs: 100000,
  revision: "revision",
  locations: [],
  available: true,
};
const track: Track = {
  id: "a",
  title: "Canción A",
  artist: "Artista",
  album: "",
  genres: [],
  disc: null,
  trackNumber: null,
  hidden: false,
  sources: [source],
};
class FakeAudio {
  static instances: FakeAudio[] = [];
  src = "";
  preload = "";
  currentTime = 0;
  duration = 100;
  volume = 1;
  paused = true;
  onloadedmetadata: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onplaying: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onwaiting: (() => void) | null = null;
  constructor() {
    FakeAudio.instances.push(this);
  }
  async play() {
    this.paused = false;
    this.onloadedmetadata?.();
    this.onplaying?.();
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
  load() {}
  removeAttribute() {}
}
let requests: { url: string; body: Record<string, unknown> }[];
beforeEach(() => {
  FakeAudio.instances = [];
  requests = [];
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, options?: RequestInit) => {
      requests.push({
        url,
        body: options?.body ? JSON.parse(String(options.body)) : {},
      });
      return new Response(
        JSON.stringify(
          url.endsWith("/start")
            ? { id: `lease-${requests.length}` }
            : { ok: true },
        ),
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("reproduce el original, pausa/reanuda y busca sin modificar la selección de la cinta", async () => {
  const p = new ListeningPlayer(() => {});
  await p.play(track, source);
  const audio = FakeAudio.instances[0]!;
  expect(audio.src).toBe("/api/audio/local-a");
  expect(p.state.status).toBe("playing");
  p.seek(42000);
  expect(audio.currentTime).toBe(42);
  expect(p.state.elapsedMs).toBe(42000);
  p.pause();
  expect(audio.paused).toBe(true);
  expect(p.state.status).toBe("paused");
  await p.resume();
  expect(p.state.status).toBe("playing");
  p.seek(200000);
  expect(audio.currentTime).toBe(100);
  p.seek(-1000);
  expect(audio.currentTime).toBe(0);
  await p.stop();
  expect(p.state.status).toBe("idle");
  expect(requests.some((r) => r.url.endsWith("/stop"))).toBe(true);
});
it("cambiar rápidamente de canción libera la sesión anterior e ignora sus eventos", async () => {
  const p = new ListeningPlayer(() => {});
  await p.play(track, source);
  const old = FakeAudio.instances[0]!;
  const oldEvent = old.ontimeupdate;
  await p.play(
    { ...track, id: "b", title: "B" },
    { ...source, id: "local-b", trackId: "b" },
  );
  old.currentTime = 95;
  oldEvent?.();
  expect(p.state.track?.id).toBe("b");
  expect(p.state.elapsedMs).toBe(0);
  expect(old.paused).toBe(true);
  expect(requests.filter((r) => r.url.endsWith("/stop"))).toHaveLength(1);
  await p.stop();
});
it("terminar la canción libera el bloqueo y conserva el tiempo final hasta volver a escuchar", async () => {
  const p = new ListeningPlayer(() => {});
  await p.play(track, source);
  FakeAudio.instances[0]!.onended?.();
  expect(p.state.status).toBe("ended");
  expect(p.state.elapsedMs).toBe(100000);
  await p.resume();
  expect(p.state.elapsedMs).toBe(0);
  expect(p.state.status).toBe("playing");
  await p.stop();
});
it("detener durante la preparación libera una sesión que llega tarde sin arrancar audio", async () => {
  let resolve: ((r: Response) => void) | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/start")
        ? new Promise<Response>((r) => (resolve = r))
        : new Response('{"ok":true}'),
    ),
  );
  const p = new ListeningPlayer(() => {});
  const start = p.play(track, source);
  await vi.waitFor(() => expect(resolve).toBeTypeOf("function"));
  const stop = p.stop();
  resolve!(new Response('{"id":"late"}'));
  await Promise.all([start, stop]);
  expect(p.state.status).toBe("idle");
  expect(FakeAudio.instances).toHaveLength(0);
});

it("rechaza referencias YouTube sin crear audio, sesiones ni reproductores de vídeo", async () => {
  const p = new ListeningPlayer(() => {});
  await p.play(track, { ...source, kind: "youtube", videoId: "BaW_jenozKc" });
  expect(p.state.status).toBe("error");
  expect(p.state.error).toContain("MP3");
  expect(FakeAudio.instances).toHaveLength(0);
  expect(requests).toHaveLength(0);
});

it("si el navegador exige otro gesto, mantiene la canción preparada y permite reintentar sin otra sesión", async () => {
  const blocked = new Error("Gesto requerido");
  blocked.name = "NotAllowedError";
  const play = vi
    .spyOn(FakeAudio.prototype, "play")
    .mockRejectedValueOnce(blocked);
  const p = new ListeningPlayer(() => {});
  try {
    await p.play(track, source);
    expect(p.state.status).toBe("paused");
    await p.resume();
    expect(p.state.status).toBe("playing");
    expect(requests.filter((r) => r.url.endsWith("/start"))).toHaveLength(1);
  } finally {
    await p.stop();
    play.mockRestore();
  }
});
