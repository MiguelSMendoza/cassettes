import { createContext, useContext, useState } from "react";
import {
  ListMusic,
  ListPlus,
  Plus,
  X,
  ExternalLink,
  CassetteTape,
  Pencil,
  Trash2,
  Download,
} from "lucide-react";
import type { Playlist, Track, Job } from "../domain/types";
import { displayTime } from "../domain/types";
import { api } from "./api";
import { Modal } from "./Modal";
import { MusicContext, SongButton } from "./MusicControls";

const PlaylistContext = createContext<((ids: string[]) => void) | null>(null);
export function PlaylistProvider({
  playlists,
  refresh,
  children,
}: {
  playlists: Playlist[];
  refresh: () => Promise<unknown>;
  children: React.ReactNode;
}) {
  const [ids, setIds] = useState<string[] | null>(null);
  const [target, setTarget] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const targets = playlists;
  const open = (trackIds: string[]) => {
    setIds([...new Set(trackIds)]);
    setTarget(targets[0]?.id ?? "");
    setName("");
    setError("");
  };
  return (
    <PlaylistContext.Provider value={open}>
      {children}
      {ids !== null && (
        <Modal
          title={ids.length ? "Añadir a playlist" : "Crear playlist"}
          onClose={() => {
            if (!busy) setIds(null);
          }}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              void (async () => {
                try {
                  await api(
                    target && ids.length
                      ? "/playlists/add"
                      : "/playlists/create",
                    target && ids.length
                      ? { id: target, trackIds: ids }
                      : { name, trackIds: ids },
                  );
                  await refresh();
                  setIds(null);
                } catch (e) {
                  setError(
                    e instanceof Error
                      ? e.message
                      : "No se pudo guardar la playlist.",
                  );
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {ids.length > 0 && (
              <>
                <p>
                  {ids.length === 1
                    ? "Añade esta canción"
                    : `Añade ${ids.length} canciones`}{" "}
                  a una playlist. Las que ya estén no se repetirán.
                </p>
                <label>
                  Playlist de destino
                  <select
                    value={target}
                    disabled={busy}
                    onChange={(e) => setTarget(e.target.value)}
                  >
                    {targets.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                    <option value="">Crear una nueva…</option>
                  </select>
                </label>
              </>
            )}
            {(!target || !ids.length) && (
              <label>
                Nombre de la playlist
                <input
                  autoFocus
                  required
                  maxLength={200}
                  value={name}
                  disabled={busy}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Por ejemplo, Carretera de noche"
                />
              </label>
            )}
            <p className="help">
              Se guardan referencias a las canciones. El audio permanece en su
              ubicación original.
            </p>
            {error && (
              <p role="alert" className="error-text">
                {error}
              </p>
            )}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                disabled={busy}
                onClick={() => setIds(null)}
              >
                Cancelar
              </button>
              <button
                className="primary"
                disabled={busy || ((!target || !ids.length) && !name.trim())}
              >
                {busy
                  ? "Guardando…"
                  : target && ids.length
                    ? "Añadir canciones"
                    : ids.length
                      ? "Crear y añadir"
                      : "Crear playlist"}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </PlaylistContext.Provider>
  );
}
export function PlaylistButton({
  trackId,
  title,
  trackIds,
  label,
}: {
  trackId?: string;
  title?: string;
  trackIds?: string[];
  label?: string;
}) {
  const open = useContext(PlaylistContext);
  const ids = trackIds ?? (trackId ? [trackId] : []);
  const text = label ?? `Añadir a playlist: ${title ?? "canción"}`;
  return (
    <button
      type="button"
      className={label ? "secondary" : "icon-button"}
      disabled={!open || !ids.length}
      title={text}
      aria-label={text}
      onClick={() => open?.(ids)}
    >
      <ListPlus size={17} />
      {label}
    </button>
  );
}
export function PlaylistsView({
  playlists,
  tracks,
  jobs,
  refresh,
  prepare,
}: {
  playlists: Playlist[];
  tracks: Map<string, Track>;
  jobs: Job[];
  refresh: () => Promise<unknown>;
  prepare: (id: string) => void;
}) {
  const open = useContext(PlaylistContext);
  const [chosen, setChosen] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const playlist = playlists.find((p) => p.id === chosen) ?? playlists[0];
  const [editing, setEditing] = useState<Playlist | null>(null);
  const [deleting, setDeleting] = useState<Playlist | null>(null);
  const [newName, setNewName] = useState("");
  const act = async (path: string, body: unknown) => {
    setPending(true);
    setError("");
    try {
      await api(path, body);
      await refresh();
      setEditing(null);
      setDeleting(null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se pudo guardar el cambio.",
      );
    } finally {
      setPending(false);
    }
  };
  const needsDownload =
    playlist?.items.some(
      (item) =>
        item.videoId ||
        (item.trackId &&
          tracks.get(item.trackId)?.sources.some((s) => s.kind === "youtube")),
    ) &&
    playlist.items.some(
      (item) =>
        !item.trackId ||
        !tracks
          .get(item.trackId)
          ?.sources.some((s) => s.kind === "local" && s.available),
    );

  return (
    <>
      <div className="page-heading playlists-heading">
        <div>
          <div className="eyebrow">SELECCIONES CON NOMBRE PROPIO</div>
          <h1>Playlists</h1>
          <p>
            Tu música, reunida a tu manera. Lista para escuchar y pasar a cinta.
          </p>
        </div>
        <button className="primary" onClick={() => open?.([])}>
          <Plus size={17} />
          Crear playlist
        </button>
      </div>
      {!playlists.length ? (
        <div className="panel playlist-empty">
          <ListMusic size={36} />
          <h2>Tu primera selección empieza aquí</h2>
          <p>
            Crea una playlist y añade canciones con el botón de lista junto a
            cada canción. Las listas importadas de YouTube también aparecerán
            aquí con su nombre original.
          </p>
        </div>
      ) : (
        <div className="playlist-layout">
          <aside className="panel playlist-picker" aria-label="Tus playlists">
            {playlists.map((p) => (
              <button
                key={p.id}
                className={`playlist-choice ${playlist?.id === p.id ? "active" : ""}`}
                onClick={() => {
                  setChosen(p.id);
                  setError("");
                }}
              >
                <ListMusic size={21} />
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {p.origin?.kind === "local" ? "Creada por ti" : "YouTube"}
                    {p.private ? " · Privada" : ""} · {p.items.length}{" "}
                    {p.items.length === 1 ? "canción" : "canciones"}
                  </small>
                </span>
              </button>
            ))}
          </aside>
          {playlist && (
            <section className="panel playlist-detail">
              <div className="playlist-detail-heading">
                <div>
                  <span className="eyebrow">
                    {playlist.origin?.kind === "local"
                      ? "PLAYLIST PROPIA"
                      : "IMPORTADA DE YOUTUBE"}
                  </span>
                  <h2>{playlist.name}</h2>
                  <p>
                    {playlist.items.length}{" "}
                    {playlist.items.length === 1 ? "canción" : "canciones"}
                    {playlist.partial ? " · Importación parcial" : ""}
                    {playlist.private ? " · Caché privada de la sesión" : ""}
                  </p>
                  {playlist.origin?.kind === "youtube" && (
                    <a
                      className="playlist-origin"
                      href={`https://www.youtube.com/playlist?list=${encodeURIComponent(playlist.origin.playlistId)}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Ver lista original en YouTube <ExternalLink size={14} />
                    </a>
                  )}
                </div>
                <div className="playlist-actions">
                  <button
                    className="secondary"
                    onClick={() => {
                      setError("");
                      setEditing(playlist);
                      setNewName(playlist.name);
                    }}
                  >
                    <Pencil size={16} />
                    Renombrar
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      setError("");
                      setDeleting(playlist);
                    }}
                  >
                    <Trash2 size={16} />
                    Eliminar playlist
                  </button>
                  <button
                    className="secondary"
                    disabled={!playlist.items.length}
                    onClick={() => prepare(playlist.id)}
                  >
                    <CassetteTape size={17} />
                    Preparar cinta
                  </button>
                </div>
              </div>
              {playlist.origin?.kind !== "local" && (
                <p className="help">
                  Importada con su nombre, orden y repeticiones originales. Los
                  cambios que hagas aquí solo afectan a esta copia local.
                </p>
              )}
              {needsDownload && (
                <button
                  className="secondary"
                  disabled={pending}
                  onClick={() =>
                    void act("/playlists/download", { id: playlist.id })
                  }
                >
                  <Download size={16} />
                  Descargar MP3 pendientes
                </button>
              )}
              {error && (
                <p role="alert" className="error-text">
                  {error}
                </p>
              )}
              {!playlist.items.length ? (
                <p className="playlist-empty">
                  Está vacía. Añade canciones desde la biblioteca con el botón
                  «Añadir a playlist».
                </p>
              ) : (
                <ol className="playlist-songs">
                  {playlist.items.map((item, index) => {
                    const track = item.trackId
                      ? tracks.get(item.trackId)
                      : undefined;
                    const job = jobs.find((j) => j.id === item.downloadJobId);
                    const source = track?.sources.find(
                      (s) => s.kind === "local" && s.available,
                    );
                    return (
                      <li key={item.id}>
                        <span className="playlist-position">{index + 1}</span>
                        <SongButton
                          trackId={track?.id}
                          title={track?.title ?? item.title}
                        />
                        <div className="playlist-song-name">
                          <strong>{track?.title ?? item.title}</strong>
                          <small>
                            {track?.artist ||
                              (!track || !source
                                ? job?.status === "running"
                                  ? `Descargando MP3 · ${job.progress.toFixed(0)} %`
                                  : job?.status === "queued"
                                    ? "MP3 en cola"
                                    : job?.status === "failed"
                                      ? `Error de descarga: ${job.error}`
                                      : job?.status === "cancelled"
                                        ? "Descarga cancelada"
                                        : "MP3 pendiente / no disponible"
                                : "Sin artista")}
                          </small>
                        </div>
                        <span className="duration">
                          {source?.durationMs
                            ? displayTime(source.durationMs)
                            : "—"}
                        </span>
                        <PlaylistButton
                          trackId={track?.id}
                          title={track?.title ?? item.title}
                        />
                        <button
                          className="icon-button"
                          disabled={pending}
                          aria-label={`Quitar de playlist: ${track?.title ?? item.title}`}
                          title="Quitar solo de esta playlist"
                          onClick={() => {
                            setPending(true);
                            setError("");
                            void api("/playlists/remove", {
                              id: playlist.id,
                              itemId: item.id,
                            })
                              .then(refresh)
                              .catch((e: unknown) =>
                                setError(
                                  e instanceof Error
                                    ? e.message
                                    : "No se pudo quitar la canción.",
                                ),
                              )
                              .finally(() => setPending(false));
                          }}
                        >
                          <X size={16} />
                        </button>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          )}
        </div>
      )}
      {editing && (
        <Modal
          title="Renombrar playlist"
          onClose={() => {
            if (!pending) setEditing(null);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act("/playlists/rename", { id: editing.id, name: newName });
            }}
          >
            <label>
              Nombre de la playlist
              <input
                required
                maxLength={200}
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <div className="modal-actions">
              <button
                type="button"
                className="secondary"
                disabled={pending}
                onClick={() => setEditing(null)}
              >
                Cancelar
              </button>
              <button className="primary" disabled={pending || !newName.trim()}>
                Guardar nombre
              </button>
            </div>
          </form>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="Eliminar playlist"
          onClose={() => {
            if (!pending) setDeleting(null);
          }}
        >
          <p>¿Eliminar «{deleting.name}»?</p>
          <p>
            Solo se eliminará la playlist. Sus canciones permanecerán en la
            biblioteca y sus archivos no se modificarán.
          </p>
          {error && <p role="alert">{error}</p>}
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={pending}
              onClick={() => setDeleting(null)}
            >
              Cancelar
            </button>
            <button
              className="primary"
              disabled={pending}
              onClick={() => void act("/playlists/delete", { id: deleting.id })}
            >
              Eliminar playlist
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

/** Action for all known song appearances, including source-only rows. */
export function SongPlaylistButton({
  trackId,
  sourceId,
  title,
}: {
  trackId?: string;
  sourceId?: string;
  title: string;
}) {
  const music = useContext(MusicContext);
  const id =
    trackId && music?.tracks.has(trackId)
      ? trackId
      : [...(music?.tracks.values() ?? [])].find((t) =>
          t.sources.some((s) => s.id === sourceId),
        )?.id;
  return <PlaylistButton trackId={id} title={title} />;
}
