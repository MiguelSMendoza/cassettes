import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  Music2,
  Play,
  Pause,
  Square,
  X,
  Volume2,
  VolumeX,
  LoaderCircle,
} from "lucide-react";
import type { Track, Source } from "../domain/types";
import {
  ListeningPlayer,
  emptyListening,
  type ListeningState,
} from "../playback/listening";
export function useListeningPlayer() {
  const [state, setState] = useState<ListeningState>(emptyListening);
  const ref = useRef<ListeningPlayer | null>(null);
  if (!ref.current) ref.current = new ListeningPlayer(setState);
  const player = ref.current;
  useEffect(
    () => () => {
      void player.stop();
    },
    [player],
  );
  return { state, player };
}
export const MusicContext = createContext<{
  state: ListeningState;
  player: ListeningPlayer;
  tracks: Map<string, Track>;
  choices: Record<string, string>;
  disabled: boolean;
  beforeListen: () => void;
} | null>(null);
function useMusic() {
  const value = useContext(MusicContext);
  if (!value) throw new Error("Reproductor fuera de su contexto.");
  return value;
}
function selectedSource(
  track: Track | undefined,
  choice?: string,
): Source | undefined {
  if (choice)
    return track?.sources.find(
      (s) => s.id === choice && s.kind === "local" && s.available,
    );
  return track?.sources.find((s) => s.kind === "local" && s.available);
}
export function SongButton({
  trackId,
  sourceId,
  title,
}: {
  trackId?: string;
  sourceId?: string;
  title: string;
}) {
  const music = useMusic();
  const track = trackId
    ? music.tracks.get(trackId)
    : [...music.tracks.values()].find((t) =>
        t.sources.some((s) => s.id === sourceId),
      );
  const source = selectedSource(
    track,
    sourceId ?? (track ? music.choices[track.id] : undefined),
  );
  const chosen = !!source && music.state.source?.id === source.id;
  const playing = chosen && music.state.status === "playing";
  const loading = chosen && music.state.status === "loading";
  const unavailable = !source?.available || !source.durationMs;
  const label = music.disabled
    ? `Escucha bloqueada mientras se prepara o graba una cinta: ${title}`
    : unavailable
      ? `No disponible para escuchar: ${title}`
      : playing
        ? `Pausar ${title}`
        : `Reproducir ${title}`;
  return (
    <button
      type="button"
      className={`song-play ${chosen ? "song-current" : ""} ${playing ? "song-playing" : ""} ${source?.kind === "youtube" ? "yt" : ""}`}
      aria-label={label}
      title={label}
      disabled={music.disabled || unavailable || loading}
      onClick={(e) => {
        e.stopPropagation();
        if (!track || !source || music.disabled) return;
        if (playing) music.player.pause();
        else if (chosen && music.state.status === "paused")
          void music.player.resume();
        else {
          music.beforeListen();
          void music.player.play(track, source);
        }
      }}
    >
      {!chosen && <Music2 className="song-note" size={19} />}
      {loading ? (
        <LoaderCircle size={19} className="spin" />
      ) : playing ? (
        <Pause size={19} />
      ) : (
        <Play size={19} className={chosen ? "" : "song-action"} />
      )}
    </button>
  );
}
function time(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function MusicBar() {
  const { state: s, player, disabled } = useMusic();
  const [scrub, setScrub] = useState<number | null>(null);
  useEffect(() => setScrub(null), [s.source?.id]);
  if (!s.track || disabled) return null;
  const playing = s.status === "playing",
    seeking = s.status === "playing" || s.status === "paused";
  function commit() {
    if (scrub !== null) {
      player.seek(scrub);
      setScrub(null);
    }
  }
  return (
    <section className="music-player" aria-label="Reproductor de música">
      <div className="music-player-track">
        <SongButton
          trackId={s.track.id}
          sourceId={s.source?.id}
          title={s.track.title}
        />
        <div>
          <strong title={s.track.title}>{s.track.title}</strong>
          <small>
            {s.track.artist ||
              (s.source?.kind === "youtube" ? "YouTube" : "Audio local")}
          </small>
        </div>
      </div>
      <div className="music-player-main">
        <div className="music-player-buttons">
          <button
            className="music-main-control"
            aria-label={playing ? "Pausar canción" : "Reproducir canción"}
            disabled={s.status === "loading"}
            onClick={() => (playing ? player.pause() : void player.resume())}
          >
            {s.status === "loading" ? (
              <LoaderCircle className="spin" size={20} />
            ) : playing ? (
              <Pause size={20} />
            ) : (
              <Play size={20} />
            )}
          </button>
          <button
            className="icon-button"
            aria-label="Detener canción"
            onClick={() => void player.stop()}
          >
            <Square size={17} />
          </button>
          <small aria-live="polite">
            {s.status === "loading"
              ? "Preparando…"
              : s.status === "paused"
                ? "En pausa"
                : s.status === "ended"
                  ? "Canción terminada"
                  : s.status === "error"
                    ? "No se pudo reproducir"
                    : "Escuchando"}
          </small>
        </div>
        <div className="music-progress">
          <span aria-label="Tiempo reproducido">
            {time(scrub ?? s.elapsedMs)}
          </span>
          <input
            type="range"
            aria-label="Posición de la canción"
            aria-valuetext={`${time(scrub ?? s.elapsedMs)} de ${time(s.durationMs)}`}
            min={0}
            max={Math.max(1, s.durationMs)}
            step={100}
            value={Math.min(scrub ?? s.elapsedMs, s.durationMs)}
            disabled={!seeking}
            onChange={(e) => setScrub(Number(e.target.value))}
            onPointerUp={commit}
            onPointerCancel={() => setScrub(null)}
            onKeyUp={commit}
            onBlur={commit}
          />
          <span aria-label="Duración total">{time(s.durationMs)}</span>
        </div>
      </div>
      <div className="music-player-volume">
        <button
          className="icon-button"
          aria-label={s.volume === 0 ? "Activar sonido" : "Silenciar"}
          onClick={() => player.setVolume(s.volume === 0 ? 1 : 0)}
        >
          {s.volume === 0 ? <VolumeX size={19} /> : <Volume2 size={19} />}
        </button>
        <input
          type="range"
          aria-label="Volumen"
          min={0}
          max={1}
          step={0.01}
          value={s.volume}
          onChange={(e) => player.setVolume(Number(e.target.value))}
        />
        <button
          className="icon-button"
          aria-label="Cerrar reproductor"
          onClick={() => void player.stop()}
        >
          <X size={19} />
        </button>
      </div>
      {s.error && (
        <p role="alert" className="music-player-error">
          {s.error}
        </p>
      )}
    </section>
  );
}
