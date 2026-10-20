import { it, expect, vi, afterEach } from "vitest";
import { Recorder } from "../src/playback/recorder";
import { defaultConfig, type Side } from "../src/domain/types";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("la grabación local respeta pausas y reanudación sin arrancar vídeos", async () => {
  vi.useFakeTimers();
  const play = vi.fn(),
    pause = vi.fn();
  class Context {
    base = Date.now();
    saved = 0;
    paused = false;
    destination = {};
    get currentTime() {
      return this.saved + (this.paused ? 0 : (Date.now() - this.base) / 1000);
    }
    async resume() {
      this.base = Date.now();
      this.paused = false;
    }
    async suspend() {
      this.saved = this.currentTime;
      this.paused = true;
    }
    async close() {
      this.paused = true;
    }
    async decodeAudioData() {
      return { length: 8000, sampleRate: 8000, numberOfChannels: 1 };
    }
    createBufferSource() {
      const node = {
        buffer: null,
        connect: vi.fn(),
        disconnect: vi.fn(),
        onended: null as (() => void) | null,
        start() {
          setTimeout(() => node.onended?.(), 1000);
        },
        stop: vi.fn(),
      };
      return node;
    }
  }
  class Player {
    constructor(
      _id: string,
      private options: {
        events: {
          onReady: () => void;
          onStateChange: (e: { data: number }) => void;
        };
      },
    ) {
      queueMicrotask(() => options.events.onReady());
    }
    loadVideoById() {
      this.options.events.onStateChange({ data: 1 });
      setTimeout(() => this.options.events.onStateChange({ data: 0 }), 1000);
    }
    playVideo() {
      play();
    }
    pauseVideo() {
      pause();
    }
    stopVideo() {}
    destroy() {}
  }
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("window", {
    YT: { Player },
    location: { origin: "http://127.0.0.1:5173" },
  });
  vi.stubGlobal("document", {
    hidden: false,
    getElementById: () => ({ append: vi.fn() }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createElement: () => ({}),
    head: { append: vi.fn() },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.includes("/audio/")
        ? new Response(new Uint8Array([0]))
        : new Response(JSON.stringify({ id: "lease", ok: true }), {
            headers: { "content-type": "application/json" },
          }),
    ),
  );
  const side: Side = {
    id: "1A",
    tape: 1,
    face: "A",
    programMs: 6000,
    occupiedMs: 16000,
    freeMs: 1784000,
    tracks: [
      {
        id: "a",
        trackId: "a",
        sourceId: "a",
        revision: "1",
        title: "YouTube",
        artist: "",
        kind: "local",
        durationMs: 1000,
        videoId: "BaW_jenozKc",
      },
      {
        id: "b",
        trackId: "b",
        sourceId: "b",
        revision: "1",
        title: "Local",
        artist: "",
        kind: "local",
        durationMs: 1000,
      },
    ],
  };
  const recorder = new Recorder(() => {});
  const config = { ...defaultConfig, initialMs: 2000, gapMs: 2000 };
  await recorder.start(side, config);
  await vi.advanceTimersByTimeAsync(5200);
  expect(recorder.state.title).toBe("Local");
  await recorder.pause();
  await recorder.resume();
  expect(play).not.toHaveBeenCalled();
  expect(recorder.state.status).toBe("playing");
  await recorder.stop();
});

it("rechaza planes antiguos con vídeo antes de abrir audio o iniciar sesión", async () => {
  const r = new Recorder(() => {});
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  vi.stubGlobal("document", {
    removeEventListener: vi.fn(),
    getElementById: () => null,
  });
  await r.start(
    {
      id: "a",
      tape: 1,
      face: "A",
      programMs: 1000,
      occupiedMs: 1000,
      freeMs: 0,
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
    defaultConfig,
  );
  expect(r.state.status).toBe("error");
  expect(r.state.error).toContain("MP3");
  expect(fetch).not.toHaveBeenCalled();
});
