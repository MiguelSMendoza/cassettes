import type { Source, Track } from "../domain/types";
import { api } from "../client/api";
export interface ListeningState {
  status: "idle" | "loading" | "playing" | "paused" | "ended" | "error";
  track: Track | null;
  source: Source | null;
  elapsedMs: number;
  durationMs: number;
  volume: number;
  error: string | null;
}
export const emptyListening: ListeningState = {
  status: "idle",
  track: null,
  source: null,
  elapsedMs: 0,
  durationMs: 0,
  volume: 1,
  error: null,
};
export class ListeningPlayer {
  state: ListeningState = { ...emptyListening };
  private audio: HTMLAudioElement | null = null;
  private lease: string | null = null;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private releasing: Promise<void> = Promise.resolve();
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  constructor(private publish: (state: ListeningState) => void) {}
  private set(change: Partial<ListeningState>) {
    this.state = { ...this.state, ...change };
    this.publish({ ...this.state });
  }
  private detach() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.audio) {
      this.audio.onloadedmetadata = null;
      this.audio.ontimeupdate = null;
      this.audio.onended = null;
      this.audio.onerror = null;
      this.audio.onplaying = null;
      this.audio.onpause = null;
      this.audio.onwaiting = null;
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
      this.audio = null;
    }
  }

  private async release() {
    const id = this.lease;
    this.lease = null;
    if (id)
      this.releasing = this.releasing
        .then(() => api("/session/stop", { id }))
        .then(() => {})
        .catch(() => {});
    await this.releasing;
  }
  async play(track: Track, source: Source) {
    const gen = ++this.generation;
    this.detach();
    this.set({
      status: "loading",
      track,
      source,
      elapsedMs: 0,
      durationMs: source.durationMs ?? 0,
      error: null,
    });
    const current = () => gen === this.generation;
    const fail = (e: unknown) => {
      if (current()) {
        this.detach();
        this.set({
          status: "error",
          error:
            e instanceof Error
              ? e.message
              : "No se pudo reproducir la canción.",
        });
        void this.release();
      }
    };
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        await this.release();
        if (!current()) return;
        try {
          if (source.kind !== "local")
            throw new Error(
              "Descarga primero el MP3. Solo se reproduce audio local.",
            );
          if (!source.available || !source.durationMs)
            throw new Error(
              "Esta canción no está disponible. Revisa su ubicación o actualiza la biblioteca.",
            );
          const lease = await api<{ id: string }>("/session/start", {
            tracks: [
              {
                id: track.id,
                trackId: track.id,
                sourceId: source.id,
                revision: source.revision,
                title: track.title,
                artist: track.artist,
                kind: source.kind,
                videoId: source.videoId,
                durationMs: source.durationMs,
              },
            ],
          });
          if (!current()) {
            await api("/session/stop", { id: lease.id });
            return;
          }
          this.lease = lease.id;
          this.heartbeat = setInterval(
            () => void api("/session/heartbeat", { id: lease.id }).catch(fail),
            10000,
          );
          const ended = () => {
            if (current()) {
              this.set({ status: "ended", elapsedMs: this.state.durationMs });
              if (this.heartbeat) clearInterval(this.heartbeat);
              void this.release();
            }
          };
          if (source.kind === "local") {
            const audio = new Audio();
            this.audio = audio;
            audio.preload = "metadata";
            audio.volume = this.state.volume;
            audio.onloadedmetadata = () => {
              if (current() && Number.isFinite(audio.duration))
                this.set({ durationMs: audio.duration * 1000 });
            };
            audio.ontimeupdate = () => {
              if (current()) this.set({ elapsedMs: audio.currentTime * 1000 });
            };
            audio.onplaying = () => {
              if (current()) this.set({ status: "playing", error: null });
            };
            audio.onpause = () => {
              if (current() && this.state.status !== "ended")
                this.set({ status: "paused" });
            };
            audio.onwaiting = () => {
              if (current()) this.set({ status: "loading" });
            };
            audio.onended = ended;
            audio.onerror = () =>
              fail(
                new Error(
                  "No se pudo leer el audio original. Comprueba que el archivo y el disco siguen disponibles.",
                ),
              );
            audio.src = `/api/audio/${source.id}`;
            await audio.play();
          }
        } catch (e) {
          if (
            current() &&
            this.audio &&
            e instanceof Error &&
            e.name === "NotAllowedError"
          )
            this.set({
              status: "paused",
              error: "Pulsa reproducir para iniciar el audio.",
            });
          else fail(e);
        }
      });
    return this.queue;
  }
  pause() {
    if (this.state.status !== "playing" && this.state.status !== "loading")
      return;
    this.audio?.pause();
    this.set({ status: "paused" });
  }
  async resume() {
    if (!this.state.track || !this.state.source) return;
    if (this.state.status === "ended" || this.state.status === "error")
      return this.play(this.state.track, this.state.source);
    if (this.state.status !== "paused") return;
    try {
      if (this.audio) await this.audio.play();
    } catch (e) {
      this.set({
        status: "error",
        error: e instanceof Error ? e.message : "No se pudo continuar.",
      });
      this.detach();
      await this.release();
    }
  }
  seek(ms: number) {
    if (
      !Number.isFinite(ms) ||
      !["playing", "paused"].includes(this.state.status)
    )
      return;
    const position = Math.max(0, Math.min(ms, this.state.durationMs));
    try {
      if (this.audio) this.audio.currentTime = position / 1000;
      this.set({ elapsedMs: position });
    } catch {
      this.set({ error: "Todavía no se puede avanzar en esta canción." });
    }
  }
  setVolume(volume: number) {
    const v = Math.max(0, Math.min(1, volume));
    if (!Number.isFinite(v)) return;
    if (this.audio) this.audio.volume = v;
    this.set({ volume: v });
  }
  async stop() {
    ++this.generation;
    this.detach();
    this.set({ ...emptyListening, volume: this.state.volume });
    this.queue = this.queue.catch(() => {}).then(() => this.release());
    await this.queue;
  }
}
