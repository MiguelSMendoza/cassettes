import type { Side, PlanConfig } from "../domain/types";
import { api } from "../client/api";
import { decodeLocalAudio } from "./decode";
export interface PlaybackState {
  status: "idle" | "preparing" | "playing" | "paused" | "completed" | "error";
  segment: "inicio" | "cancion" | "intervalo" | "final";
  elapsedMs: number;
  title: string;
  error: string | null;
}
export class Recorder {
  state: PlaybackState = {
    status: "idle",
    segment: "inicio",
    elapsedMs: 0,
    title: "",
    error: null,
  };
  private context: AudioContext | null = null;
  private nodes: AudioBufferSourceNode[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private abort = new AbortController();
  private sessionId: string | null = null;
  private generation = 0;
  private started = 0;
  constructor(private publish: (s: PlaybackState) => void) {}
  private set(change: Partial<PlaybackState>) {
    this.state = { ...this.state, ...change };
    this.publish({ ...this.state });
  }
  async start(side: Side, config: PlanConfig) {
    await this.stop();
    if (side.tracks.some((t) => t.kind !== "local")) {
      this.set({
        status: "error",
        error:
          "Descarga primero los MP3 y vuelve a preparar la cinta. Solo se reproduce audio local.",
      });
      return;
    }
    const gen = ++this.generation;
    this.abort = new AbortController();
    this.context = new AudioContext();
    await this.context.resume();
    this.set({
      status: "preparing",
      segment: "inicio",
      elapsedMs: 0,
      error: null,
      title: "Comprobando la cara…",
    });
    try {
      const lease = await api<{ id: string }>(
        "/session/start",
        { tracks: side.tracks },
        this.abort.signal,
      );
      if (gen !== this.generation) {
        await api("/session/stop", { id: lease.id });
        return;
      }
      this.sessionId = lease.id;
      this.heartbeat = setInterval(() => {
        void api("/session/heartbeat", { id: lease.id }).catch((e) => {
          if (gen === this.generation) this.fail(e);
        });
      }, 10000);
      const buffers = new Map<string, AudioBuffer>();
      let memory = 0;
      for (const t of side.tracks) {
        if (t.kind !== "local" || buffers.has(t.sourceId)) continue;
        this.set({ title: `Preparando: ${t.title}` });
        const buffer = await decodeLocalAudio(
          this.context,
          t.sourceId,
          t.title,
          t.revision,
          this.abort.signal,
        );
        memory += buffer.length * buffer.numberOfChannels * 4;
        if (memory > 1_300_000_000)
          throw new Error(
            "Esta cara necesita demasiada memoria decodificada (límite: 1,3 GB).",
          );
        const actual = Math.ceil((buffer.length / buffer.sampleRate) * 1000);
        if (actual > t.durationMs + 1)
          throw new Error(
            `La duración real de «${t.title}» supera la del plan. Genera de nuevo para actualizarla.`,
          );
        buffers.set(t.sourceId, buffer);
        if (gen !== this.generation) return;
      }
      if (gen !== this.generation) return;
      this.started = this.context.currentTime + 0.15;
      this.set({
        status: "playing",
        title: "Silencio inicial",
        segment: "inicio",
      });
      let offset = config.initialMs;
      const segments: {
        start: number;
        end: number;
        segment: PlaybackState["segment"];
        title: string;
      }[] = [
        {
          start: 0,
          end: offset,
          segment: "inicio",
          title: "Silencio inicial",
        },
      ];
      for (const [i, t] of side.tracks.entries()) {
        const buffer = buffers.get(t.sourceId)!;
        const node = this.context.createBufferSource();
        node.buffer = buffer;
        node.connect(this.context.destination);
        node.start(this.started + offset / 1000);
        this.nodes.push(node);
        segments.push({
          start: offset,
          end: offset + t.durationMs,
          segment: "cancion",
          title: t.title,
        });
        offset += t.durationMs;
        if (i < side.tracks.length - 1) {
          segments.push({
            start: offset,
            end: offset + config.gapMs,
            segment: "intervalo",
            title: "Silencio entre canciones",
          });
          offset += config.gapMs;
        }
      }
      segments.push({
        start: offset,
        end: offset + config.finalMs,
        segment: "final",
        title: "Silencio final",
      });
      offset += config.finalMs;
      this.timer = setInterval(() => {
        if (!this.context || this.state.status === "paused") return;
        const elapsed = Math.max(
          0,
          (this.context.currentTime - this.started) * 1000,
        );
        const segment = segments.find(
          (s) => elapsed >= s.start && elapsed < s.end,
        );
        this.set({
          elapsedMs: Math.min(elapsed, offset),
          ...(segment
            ? { segment: segment.segment, title: segment.title }
            : {}),
        });
        if (elapsed >= offset) void this.finish();
      }, 100);
    } catch (e) {
      if (gen === this.generation) this.fail(e);
    }
  }
  async pause() {
    if (this.state.status !== "playing") return;
    await this.context?.suspend();
    this.set({ status: "paused" });
  }
  async resume() {
    if (this.state.status !== "paused") return;
    await this.context?.resume();
    this.set({ status: "playing", error: null });
  }
  private fail(e: unknown) {
    const error =
      e instanceof Error ? e.message : "La reproducción se interrumpió.";
    void this.stop().then(() =>
      this.set({
        status: "error",
        error,
        title: "Revisa la grabadora antes de repetir la cara.",
      }),
    );
  }
  private async finish() {
    const elapsed = this.state.elapsedMs;
    await this.stop();
    this.set({
      status: "completed",
      elapsedMs: elapsed,
      title: "Cara terminada. Detén la grabadora y cambia la cinta.",
    });
  }
  async stop() {
    ++this.generation;
    this.abort.abort();
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.timer = null;
    this.heartbeat = null;
    for (const n of this.nodes) {
      try {
        n.stop();
        n.disconnect();
      } catch {
        /* Ya terminó. */
      }
    }
    this.nodes = [];
    if (this.context) {
      await this.context.close().catch(() => {});
      this.context = null;
    }
    const lease = this.sessionId;
    this.sessionId = null;
    if (lease) await api("/session/stop", { id: lease }).catch(() => {});
    this.set({ status: "idle", elapsedMs: 0, title: "", error: null });
  }
}
