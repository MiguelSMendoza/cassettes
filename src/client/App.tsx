import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioLines,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Disc3,
  Download,
  Folder,
  FolderOpen,
  Headphones,
  Library,
  Link2,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Shuffle,
  Square,
  CassetteTape as Tape,
  Trash2,
  Upload,
  X,
  FilePenLine,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  SlidersHorizontal,
  Layers3,
} from "lucide-react";
import type {
  Snapshot,
  Track,
  Plan,
  PlanConfig,
  Occurrence,
  Side,
  Operation,
  Playlist,
  Source,
} from "../domain/types";
import { defaultConfig, displayTime } from "../domain/types";
import { shuffle } from "../domain/planner";
import { makeOccurrences } from "../domain/selection";
import {
  moveOccurrence,
  updatePlanTrackMetadata,
  syncPlanTrackMetadata,
  removeOccurrence,
} from "../domain/edit-plan";
import { api } from "./api";
import {
  MusicContext,
  MusicBar,
  SongButton,
  useListeningPlayer,
} from "./MusicControls";
import { Modal } from "./Modal";
import {
  PlaylistProvider,
  PlaylistsView,
  SongPlaylistButton,
  PlaylistButton,
} from "./Playlists";
import { LocalImport } from "./LocalImport";
import { CoverButton } from "./CoverButton";
import { AddSideTrackDialog, CopySidesDialog } from "./SideDialogs";
import { prepareTrackAddition } from "../playback/prepare-addition";
import { decodeLocalAudio } from "../playback/decode";
import { Recorder, type PlaybackState } from "../playback/recorder";
type Page =
  "library" | "import" | "playlists" | "plans" | "folder" | "settings";
type LibraryFilter = "artist" | "album" | "genre";
const pageNames: Record<Page, string> = {
  library: "Biblioteca",
  playlists: "Playlists",
  import: "Importar música",
  plans: "Mis cintas",
  folder: "Carpeta musical",
  settings: "Ajustes",
};
const emptyPlayback: PlaybackState = {
  status: "idle",
  segment: "inicio",
  elapsedMs: 0,
  title: "",
  error: null,
};
function chooseSource(track: Track) {
  return (
    track.sources.find((s) => s.kind === "local" && s.available) ??
    track.sources.find((s) => s.available) ??
    track.sources[0]
  );
}
function Cassette({
  profile = 60,
  small = false,
}: {
  profile?: number;
  small?: boolean;
}) {
  return (
    <div className={`cassette ${small ? "small" : ""}`} aria-hidden="true">
      <div className="cassette-screw tl" />
      <div className="cassette-screw tr" />
      <div className="cassette-label">
        <div className="cassette-brand">
          CASSETTES<span>HIGH FIDELITY</span>
        </div>
        <div className="cassette-lines">
          <span>A</span>
          <i />
          <b>C{profile}</b>
        </div>
        <div className="cassette-window">
          <div className="reel" />
          <div className="tape-window" />
          <div className="reel" />
        </div>
        <div className="cassette-bottom-label">
          NORMAL POSITION <span>STEREO · TYPE I</span>
        </div>
      </div>
      <div className="cassette-foot">
        <i />
        <i />
        <i />
      </div>
      <div className="cassette-screw bl" />
      <div className="cassette-screw br" />
    </div>
  );
}
export function App() {
  const listening = useListeningPlayer();
  const [startingRecording, setStartingRecording] = useState(false);
  const [state, setState] = useState<Snapshot | null>(null),
    [page, setPage] = useState<Page>("library"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState("");
  const [search, setSearch] = useState(""),
    [artist, setArtist] = useState(""),
    [genre, setGenre] = useState(""),
    [album, setAlbum] = useState(""),
    [sort, setSort] = useState("title"),
    [group, setGroup] = useState(""),
    [selected, setSelected] = useState<Set<string>>(new Set()),
    [viewPage, setViewPage] = useState(0),
    [mixSeed, setMixSeed] = useState(0);
  const [links, setLinks] = useState(""),
    [importTab, setImportTab] = useState<"links" | "playlist" | "files">(
      "links",
    ),
    [privateList, setPrivateList] = useState(false),
    [playlistPreview, setPlaylistPreview] = useState<Playlist | null>(null),
    [results, setResults] = useState<
      { url?: string; name?: string; error?: string; duplicate?: boolean }[]
    >([]);
  const [config, setConfig] = useState<PlanConfig>(defaultConfig),
    [planDraft, setPlan] = useState<Plan | null>(null),
    [workerBusy, setWorkerBusy] = useState(false),
    [playlistId, setPlaylistId] = useState(""),
    [keepRepeats, setKeepRepeats] = useState(true),
    [addSide, setAddSide] = useState<string | null>(null),
    [copySide, setCopySide] = useState<string | null>(null),
    [sourceChoices, setSourceChoices] = useState<Record<string, string>>({});
  const [rootPath, setRootPath] = useState(""),
    [rootPreview, setRootPreview] = useState<{
      id: string;
      path: string;
    } | null>(null),
    [operation, setOperation] = useState<Operation | null>(null),
    [detail, setDetail] = useState<Track | null>(null),
    [rename, setRename] = useState<{ locationId: string; name: string } | null>(
      null,
    ),
    [restorePreview, setRestorePreview] = useState<{
      id: string;
      tracks: number;
      plans: number;
      message: string;
    } | null>(null);
  const [playback, setPlayback] = useState(emptyPlayback),
    [sideIndex, setSideIndex] = useState(0),
    [recordConfirm, setRecordConfirm] = useState(false);
  const planningGeneration = useRef(0),
    planningAbort = useRef<AbortController | null>(null);
  const recorder = useRef<Recorder | null>(null),
    worker = useRef<Worker | null>(null),
    restoreInput = useRef<HTMLInputElement>(null);
  const refresh = async () => {
    const data = await api<Snapshot>("/state");
    setState(data);
    return data;
  };
  useEffect(() => {
    let active = true;
    const load = () => {
      api<Snapshot>("/state")
        .then((s) => {
          if (active) {
            setState(s);
            setError((prev) =>
              prev === "No se puede conectar con el servidor local."
                ? ""
                : prev,
            );
          }
        })
        .catch(() => {
          if (active) setError("No se puede conectar con el servidor local.");
        });
    };
    load();
    const timer = setInterval(load, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    const r = new Recorder(setPlayback);
    recorder.current = r;
    return () => {
      void r.stop();
      worker.current?.terminate();
    };
  }, []);
  async function run(label: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se pudo completar la operación.",
      );
    } finally {
      setBusy("");
    }
  }
  const tracks = state?.tracks.filter((t) => !t.hidden) ?? [];
  const trackMap = new Map(state?.tracks.map((t) => [t.id, t]));
  const plan = useMemo(
    () =>
      planDraft ? syncPlanTrackMetadata(planDraft, state?.tracks ?? []) : null,
    [planDraft, state?.tracks],
  );
  const availableSource = (t: Track) =>
    t.sources.find((s) => s.id === sourceChoices[t.id]) ?? chooseSource(t);
  const visible = useMemo(() => {
    let rows = (state?.tracks ?? [])
      .filter((t) => !t.hidden)
      .filter(
        (t) =>
          (!search ||
            [t.title, t.artist, t.album, ...t.genres]
              .join(" ")
              .toLocaleLowerCase("es")
              .includes(search.toLocaleLowerCase("es"))) &&
          (!artist || t.artist === artist) &&
          (!album || t.album === album) &&
          (!genre || t.genres.includes(genre)),
      );
    if (mixSeed) return shuffle(rows, mixSeed);
    const compare = new Intl.Collator("es", {
      sensitivity: "base",
      numeric: true,
    });
    const field = (t: Track) =>
      sort === "artist"
        ? t.artist
        : sort === "album"
          ? t.album
          : sort === "genre"
            ? t.genres.join(", ")
            : t.title;
    rows = [...rows].sort((a, b) => {
      if (sort === "duration")
        return (
          (chooseSource(a)?.durationMs ?? Infinity) -
            (chooseSource(b)?.durationMs ?? Infinity) ||
          a.id.localeCompare(b.id)
        );
      const aa = field(a),
        bb = field(b);
      if (!aa) return bb ? 1 : a.id.localeCompare(b.id);
      if (!bb) return -1;
      const compared = compare.compare(aa, bb);
      if (compared) return compared;
      if (sort === "album")
        return (
          (a.disc ?? Infinity) - (b.disc ?? Infinity) ||
          (a.trackNumber ?? Infinity) - (b.trackNumber ?? Infinity) ||
          compare.compare(a.title, b.title)
        );
      return a.id.localeCompare(b.id);
    });
    return rows;
  }, [state, search, artist, album, genre, sort, mixSeed]);
  const view = visible.slice(viewPage * 100, (viewPage + 1) * 100);
  useEffect(
    () => setViewPage(0),
    [search, artist, album, genre, sort, mixSeed],
  );
  const artists = [
      ...new Set(tracks.map((t) => t.artist).filter(Boolean)),
    ].sort(),
    albums = [...new Set(tracks.map((t) => t.album).filter(Boolean))].sort(),
    genres = [...new Set(tracks.flatMap((t) => t.genres))].sort();
  const localCount = tracks.filter((t) =>
    t.sources.some((s) => s.kind === "local" && s.available),
  ).length;
  const duplicateTracks = tracks.filter((t) =>
    t.sources.some((s) => s.locations.filter((l) => l.available).length > 1),
  );
  const totalMs = tracks.reduce(
    (s, t) => s + (chooseSource(t)?.durationMs ?? 0),
    0,
  );
  const active = ["preparing", "playing", "paused"].includes(playback.status);
  const nonemptySides = plan?.sides.filter((s) => s.tracks.length) ?? [];
  const currentSide = nonemptySides[sideIndex];
  function filterBy(field: LibraryFilter, value: string) {
    setSearch("");
    setArtist(field === "artist" ? value : "");
    setAlbum(field === "album" ? value : "");
    setGenre(field === "genre" ? value : "");
    setViewPage(0);
  }
  function clearFilters() {
    setSearch("");
    setArtist("");
    setAlbum("");
    setGenre("");
    setViewPage(0);
  }
  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function occurrences(input: Track[], playlist?: Playlist) {
    return makeOccurrences(input, {
      playlist,
      allTracks: state?.tracks ?? [],
      keepRepeats,
      sourceChoices,
    });
  }
  async function generate(scope: "all" | "selected" | "playlist") {
    if (active) {
      setError("Detén la grabación antes de generar otra selección.");
      return;
    }
    const baseInput = mixSeed ? shuffle(tracks, mixSeed) : tracks;
    const input =
      scope === "selected"
        ? baseInput.filter((t) => selected.has(t.id))
        : baseInput;
    const playlist =
      scope === "playlist"
        ? state?.playlists.find((p) => p.id === playlistId)
        : undefined;
    if (!input.length && !playlist) {
      setNotice("Añade canciones a tu biblioteca para preparar una cinta.");
      setPage("import");
      return;
    }
    let items = occurrences(input, playlist);
    if (!items.length) {
      setError("La selección no contiene canciones.");
      return;
    }
    const runId = ++planningGeneration.current;
    const controller = new AbortController();
    planningAbort.current = controller;
    setWorkerBusy(true);
    setError("");
    try {
      // Preparar una cinta recalibra duraciones/revisiones: liberar la escucha
      // antes de modificarlas y mantener un único transporte durante ese paso.
      await listening.player.stop();
      if (runId !== planningGeneration.current) return;
      const context = new AudioContext();
      const checkedSources = new Set<string>();
      const compatible: string[] = [],
        recovered: string[] = [];
      try {
        for (const item of items) {
          if (
            item.kind !== "local" ||
            item.durationMs === 0 ||
            checkedSources.has(item.sourceId)
          )
            continue;
          if (runId !== planningGeneration.current) return;
          const buffer = await decodeLocalAudio(
            context,
            item.sourceId,
            item.title,
            item.revision,
            controller.signal,
            (warnings) => {
              compatible.push(item.title);
              if (warnings) recovered.push(item.title);
              setNotice(
                `Audio preparado en formato compatible para ${compatible.length} ${compatible.length === 1 ? "canción" : "canciones"}, sin modificar originales.${recovered.length ? ` Archivos con errores recuperables: ${recovered.join("; ")}. Revisa la escucha antes de grabar.` : ""}`,
              );
            },
          );
          checkedSources.add(item.sourceId);
          const measured = Math.ceil(
            (buffer.length / buffer.sampleRate) * 1000,
          );
          if (measured !== item.durationMs) {
            const update = await api<{ revision: string }>(
              "/sources/duration",
              {
                sourceId: item.sourceId,
                durationMs: measured,
                revision: item.revision,
              },
            );
            for (const same of items.filter(
              (t) => t.sourceId === item.sourceId,
            )) {
              same.durationMs = measured;
              same.revision = update.revision;
            }
          }
        }
      } finally {
        await context.close();
      }
      if (runId !== planningGeneration.current) return;
      const w = new Worker(new URL("../planner/worker.ts", import.meta.url), {
        type: "module",
      });
      worker.current = w;
      w.onmessage = (e: MessageEvent<{ plan?: Plan; error?: string }>) => {
        setWorkerBusy(false);
        w.terminate();
        worker.current = null;
        if (e.data.error) setError(e.data.error);
        else if (e.data.plan) {
          setPlan(e.data.plan);
          setSideIndex(0);
          setPage("plans");
          void refresh();
        }
      };
      w.onerror = () => {
        setWorkerBusy(false);
        setError("No se pudo terminar el reparto.");
        w.terminate();
      };
      w.postMessage({ tracks: items, config });
    } catch (e) {
      if (runId !== planningGeneration.current) return;
      setWorkerBusy(false);
      setError(
        e instanceof Error ? e.message : "No se pudo preparar el audio.",
      );
    }
  }
  function cancelGenerate() {
    planningGeneration.current++;
    planningAbort.current?.abort();
    worker.current?.terminate();
    worker.current = null;
    setWorkerBusy(false);
  }
  function editPlan(occurrenceId: string, target: string, offset?: number) {
    if (!plan || active) return;
    try {
      setPlan({
        ...moveOccurrence(plan, occurrenceId, target, offset),
        id: plan.id,
        createdAt: plan.createdAt,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo mover la canción.");
    }
  }
  async function downloadTracks(input: Track[]) {
    const urls = input.flatMap((t) =>
      t.sources
        .filter((s) => s.kind === "youtube" && s.videoId)
        .map((s) => `https://www.youtube.com/watch?v=${s.videoId}`),
    );
    if (!urls.length)
      throw new Error("Selecciona canciones con una referencia de YouTube.");
    await api("/downloads", { urls });
    setNotice("Canciones añadidas a la cola de MP3.");
  }
  const importAction = () =>
    run("Analizando enlaces", async () => {
      const urls = links.split(/\s+/).filter(Boolean);
      if (!urls.length) throw new Error("Pega uno o varios enlaces.");
      await api("/youtube/import", { urls });
      setResults([]);
      setNotice(
        "Descargas MP3 en cola. Se añadirán a la biblioteca al terminar.",
      );
    });
  const previewFile = async (
    locationId: string,
    action: "rename" | "trash" | "restore",
    name?: string,
  ) => {
    const op = await api<Operation>("/files/preview", {
      locationId,
      action,
      name,
    });
    setRename(null);
    setDetail(null);
    setOperation(op);
  };
  const hiddenCount = state?.tracks.filter((t) => t.hidden).length ?? 0;
  if (!state)
    return (
      <div className="loading-screen">
        <Tape size={44} />
        <h1>Cassettes</h1>
        <p>{error || "Preparando tu espacio de escucha…"}</p>
        <LoaderCircle className="spin" />
      </div>
    );
  const content = (
    <div
      className={`app-shell ${listening.state.track ? "has-music-player" : ""}`}
    >
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setPage("library");
          }}
        >
          <span className="brand-mark">
            <Tape size={25} />
          </span>
          Cassettes<span className="brand-dot">.</span>
        </a>
        <div className="workspace-label">TU ESPACIO DE ESCUCHA</div>
        <nav>
          {(
            [
              {
                id: "library",
                icon: Library,
                label: "Biblioteca",
                count: tracks.length,
              },
              { id: "import", icon: Plus, label: "Importar música" },
              {
                id: "playlists",
                icon: Layers3,
                label: "Playlists",
                count: state.playlists.length,
              },
              {
                id: "plans",
                icon: Tape,
                label: "Mis cintas",
                count: state.plans.length,
              },
              { id: "folder", icon: Folder, label: "Carpeta musical" },
              { id: "settings", icon: Settings2, label: "Ajustes" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              aria-label={item.label}
              className={page === item.id ? "nav-item active" : "nav-item"}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={19} />
              <span>{item.label}</span>
              {"count" in item && <b>{item.count}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <Disc3 size={23} />
          <p>
            Un poco de pausa.
            <br />
            Mucha más música.
          </p>
          <span>HECHO PARA ESCUCHAR</span>
        </div>
        <div className="local-status">
          <i />
          Funcionando en local<small>Tu música se queda contigo.</small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div className="breadcrumb">
            Tu colección <span>/</span> <strong>{pageNames[page]}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-pill">
              <span />
              LOCAL
            </span>
            <button
              className="icon-button"
              onClick={() => setPage("settings")}
              aria-label="Abrir ajustes"
            >
              <Settings2 size={18} />
            </button>
          </div>
        </header>
        <div className="content">
          {page === "playlists" && (
            <PlaylistsView
              playlists={state.playlists}
              tracks={trackMap}
              jobs={state.jobs}
              refresh={refresh}
              prepare={(id) => {
                setPlaylistId(id);
                setPage("plans");
              }}
            />
          )}
          {workerBusy && (
            <div role="status" className="notice">
              <LoaderCircle size={17} className="spin" />
              <span>Analizando duraciones y preparando las caras…</span>
              <button className="text-button" onClick={cancelGenerate}>
                Cancelar
              </button>
            </div>
          )}
          {(error || notice) && (
            <div
              role={error ? "alert" : "status"}
              className={`notice ${error ? "error" : ""}`}
            >
              {error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
              <span>{error || notice}</span>
              <button
                className="icon-button"
                aria-label="Cerrar aviso"
                onClick={() => {
                  setError("");
                  setNotice("");
                }}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {page === "library" && (
            <>
              <section className="hero">
                <div className="hero-copy">
                  <div className="eyebrow">
                    <span />
                    DEL DIGITAL AL ANALÓGICO
                  </div>
                  <h1>
                    La música de siempre.
                    <br />
                    <em>Una nueva cara.</em>
                  </h1>
                  <p>
                    Reúne tus canciones, encuentra su sitio en la cinta
                    <br className="desktop-break" /> y vuelve a escuchar sin
                    prisa.
                  </p>
                  <button className="primary" onClick={() => setPage("import")}>
                    <Plus size={17} />
                    Añadir música
                    <ArrowRight size={16} />
                  </button>
                </div>
                <div className="hero-art">
                  <span className="art-label top">
                    DISEÑADA POR TI. GRABADA A TU RITMO.
                  </span>
                  <Cassette profile={config.profile} />
                  <span className="art-label bottom">
                    TWO SIDES. ONE GOOD SELECTION.
                  </span>
                  <i className="hero-orbit" />
                </div>
              </section>
              <section className="stats-strip">
                <div>
                  <span className="stat-icon">
                    <Music2 size={19} />
                  </span>
                  <strong>
                    {tracks.length}
                    <small>Canciones en tu biblioteca</small>
                  </strong>
                </div>
                <div>
                  <span className="stat-icon">
                    <Headphones size={19} />
                  </span>
                  <strong>
                    {displayTime(totalMs)}
                    <small>Minutos de música</small>
                  </strong>
                </div>
                <div>
                  <span className="stat-icon">
                    <FolderOpen size={19} />
                  </span>
                  <strong>
                    {localCount}
                    <small>Disponibles en local</small>
                  </strong>
                </div>
                <div>
                  <span className="stat-icon">
                    <Tape size={19} />
                  </span>
                  <strong>
                    {state.plans.length}
                    <small>Selecciones guardadas</small>
                  </strong>
                </div>
              </section>
              <section className="collection">
                <div className="section-header">
                  <div>
                    <div className="eyebrow muted">
                      TU COLECCIÓN, A TU MANERA
                    </div>
                    <h2>
                      Biblioteca
                      <span className="count-badge">{tracks.length}</span>
                    </h2>
                  </div>
                  <div className="actions">
                    <button
                      className="secondary"
                      onClick={() => {
                        setMixSeed(Date.now());
                        setNotice(
                          "Biblioteca mezclada. Tus cintas guardadas conservan su orden.",
                        );
                      }}
                      disabled={!tracks.length}
                    >
                      <Shuffle size={16} />
                      Mezclar
                    </button>
                    <button
                      className="primary"
                      onClick={() =>
                        void generate(selected.size ? "selected" : "all")
                      }
                      disabled={workerBusy}
                    >
                      <Tape size={17} />
                      {selected.size
                        ? "Preparar selección"
                        : "Preparar una cinta"}
                    </button>
                  </div>
                </div>
                <div className="toolbar">
                  <div className="search-field">
                    <Search size={18} />
                    <input
                      aria-label="Buscar canciones"
                      placeholder="Buscar canciones, artistas o álbumes…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    {search && (
                      <button
                        className="icon-button"
                        aria-label="Limpiar búsqueda"
                        onClick={() => setSearch("")}
                      >
                        <X size={15} />
                      </button>
                    )}
                  </div>
                  <select
                    aria-label="Filtrar por artista"
                    value={artist}
                    onChange={(e) => setArtist(e.target.value)}
                  >
                    <option value="">Todos los artistas</option>
                    {artists.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Filtrar por género"
                    value={genre}
                    onChange={(e) => setGenre(e.target.value)}
                  >
                    <option value="">Todos los géneros</option>
                    {genres.map((a) => (
                      <option key={a}>{a}</option>
                    ))}
                  </select>
                  <button
                    className="icon-button filter-toggle"
                    aria-label="Más filtros"
                    onClick={() => setGroup(group ? "" : "album")}
                  >
                    <SlidersHorizontal size={18} />
                  </button>
                </div>
                <div className="subtoolbar">
                  <span>
                    {selected.size
                      ? `${selected.size} seleccionadas · ${[...selected].filter((id) => !visible.some((t) => t.id === id)).length} fuera de la vista`
                      : `${visible.length} canciones`}
                  </span>
                  <div>
                    <select
                      aria-label="Filtrar por álbum"
                      value={album}
                      onChange={(e) => setAlbum(e.target.value)}
                    >
                      <option value="">Todos los álbumes</option>
                      {albums.map((a) => (
                        <option key={a}>{a}</option>
                      ))}
                    </select>
                    <select
                      aria-label="Agrupar biblioteca"
                      value={group}
                      onChange={(e) => setGroup(e.target.value)}
                    >
                      <option value="">Sin agrupar</option>
                      <option value="artist">Por artista</option>
                      <option value="album">Por álbum</option>
                      <option value="genre">Por género</option>
                    </select>
                    <select
                      aria-label="Orden de biblioteca"
                      value={mixSeed ? "mixed" : sort}
                      onChange={(e) => {
                        setMixSeed(0);
                        setSort(e.target.value);
                      }}
                    >
                      {mixSeed > 0 && (
                        <option value="mixed">Orden mezclado</option>
                      )}
                      <option value="title">Nombre A–Z</option>
                      <option value="artist">Artista A–Z</option>
                      <option value="album">Álbum y pista</option>
                      <option value="genre">Género A–Z</option>
                      <option value="duration">Duración</option>
                    </select>
                  </div>
                </div>
                {(artist || album || genre || search) && (
                  <div
                    className="active-filters"
                    role="region"
                    aria-label="Filtros activos"
                  >
                    <span>Filtrando por</span>
                    {[
                      {
                        label: "artista",
                        value: artist,
                        clear: () => setArtist(""),
                      },
                      {
                        label: "álbum",
                        value: album,
                        clear: () => setAlbum(""),
                      },
                      {
                        label: "género",
                        value: genre,
                        clear: () => setGenre(""),
                      },
                      {
                        label: "búsqueda",
                        value: search,
                        clear: () => setSearch(""),
                      },
                    ]
                      .filter((f) => f.value)
                      .map((f) => (
                        <button
                          key={f.label}
                          className="filter-chip"
                          aria-label={`Quitar filtro de ${f.label}: ${f.value}`}
                          onClick={f.clear}
                        >
                          <span>
                            {f.label}: <strong>{f.value}</strong>
                          </span>
                          <X size={14} aria-hidden="true" />
                        </button>
                      ))}
                    <button className="text-button" onClick={clearFilters}>
                      Quitar todos los filtros
                    </button>
                    <span className="filter-results" role="status">
                      {visible.length}{" "}
                      {visible.length === 1 ? "canción" : "canciones"}
                    </span>
                  </div>
                )}
                {selected.size > 0 && (
                  <div className="selection-bar">
                    <span>{selected.size} seleccionadas</span>
                    <PlaylistButton
                      trackIds={[...selected]}
                      label="Añadir a playlist"
                    />
                    <button onClick={() => void generate("selected")}>
                      Organizar seleccionadas
                    </button>
                    <button
                      onClick={() =>
                        void run("Añadiendo descargas", () =>
                          downloadTracks(
                            tracks.filter((t) => selected.has(t.id)),
                          ),
                        )
                      }
                    >
                      Preparar MP3
                    </button>
                    <button
                      onClick={() =>
                        void run("Ocultando canciones", async () => {
                          await api("/tracks/visibility", {
                            ids: [...selected],
                            hidden: true,
                          });
                          setSelected(new Set());
                        })
                      }
                    >
                      Quitar de biblioteca
                    </button>
                    <button onClick={() => setSelected(new Set())}>
                      Limpiar selección
                    </button>
                  </div>
                )}
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th className="checkbox-cell">
                          <input
                            type="checkbox"
                            aria-label="Seleccionar canciones de esta página"
                            checked={
                              view.length > 0 &&
                              view.every((t) => selected.has(t.id))
                            }
                            onChange={(e) => {
                              const checked = e.target.checked;
                              setSelected((prev) => {
                                const next = new Set(prev);
                                for (const t of view)
                                  if (checked) next.add(t.id);
                                  else next.delete(t.id);
                                return next;
                              });
                            }}
                          />
                        </th>
                        <th>
                          <button
                            onClick={() => {
                              setSort("title");
                              setMixSeed(0);
                            }}
                          >
                            CANCIÓN
                          </button>
                        </th>
                        <th className="optional-column">ARTISTA</th>
                        <th className="optional-column">ÁLBUM</th>
                        <th className="genre-column">GÉNERO</th>
                        <th>TIEMPO</th>
                        <th>ORIGEN</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {group
                        ? [
                            ...new Set(
                              view.flatMap((t) =>
                                group === "genre"
                                  ? t.genres.length
                                    ? t.genres
                                    : ["Sin género"]
                                  : [
                                      group === "artist"
                                        ? t.artist || "Sin artista"
                                        : t.album || "Sin álbum",
                                    ],
                              ),
                            ),
                          ]
                            .sort()
                            .map((key) => (
                              <GroupRows
                                key={key}
                                label={key}
                                tracks={view.filter((t) =>
                                  group === "genre"
                                    ? (t.genres.length
                                        ? t.genres
                                        : ["Sin género"]
                                      ).includes(key)
                                    : (group === "artist"
                                        ? t.artist || "Sin artista"
                                        : t.album || "Sin álbum") === key,
                                )}
                                selected={selected}
                                toggle={toggle}
                                detail={setDetail}
                                filterBy={filterBy}
                                groupField={
                                  group === "artist" ||
                                  group === "album" ||
                                  group === "genre"
                                    ? group
                                    : undefined
                                }
                              />
                            ))
                        : view.map((t) => (
                            <TrackRow
                              key={t.id}
                              track={t}
                              selected={selected.has(t.id)}
                              toggle={() => toggle(t.id)}
                              detail={() => setDetail(t)}
                              filterBy={filterBy}
                            />
                          ))}
                    </tbody>
                  </table>
                </div>
                {!visible.length && (
                  <div className="empty-state">
                    <div className="empty-icon">
                      <Music2 size={27} />
                    </div>
                    <h3>
                      {tracks.length
                        ? "Ninguna canción coincide"
                        : "Toda buena cinta empieza con una canción."}
                    </h3>
                    <p>
                      {tracks.length
                        ? "Prueba otro nombre o cambia los filtros."
                        : "Añade tus archivos o pega un enlace de YouTube para empezar tu colección."}
                    </p>
                    <button
                      className="secondary"
                      onClick={() => setPage("import")}
                    >
                      <Plus size={16} />
                      Añadir mi primera canción
                    </button>
                  </div>
                )}
                {visible.length > 100 && (
                  <div className="pagination">
                    <button
                      className="secondary"
                      disabled={viewPage === 0}
                      onClick={() => setViewPage((p) => p - 1)}
                    >
                      <ArrowLeft size={15} />
                      Anterior
                    </button>
                    <span>
                      Página {viewPage + 1} de {Math.ceil(visible.length / 100)}
                    </span>
                    <button
                      className="secondary"
                      disabled={(viewPage + 1) * 100 >= visible.length}
                      onClick={() => setViewPage((p) => p + 1)}
                    >
                      Siguiente
                      <ArrowRight size={15} />
                    </button>
                  </div>
                )}
                <div className="collection-footer">
                  <Folder size={14} />
                  <span>
                    {state.root.connected
                      ? "Carpeta conectada"
                      : "Carpeta desconectada"}
                  </span>
                  <button onClick={() => setPage("folder")}>
                    Gestionar carpeta
                    <ArrowRight size={13} />
                  </button>
                </div>
              </section>
              <div className="bottom-note">
                <span>Una biblioteca digital. Infinitas combinaciones.</span>
                <span>
                  DALE LA VUELTA A TU MÚSICA <ArrowRight size={13} />
                </span>
              </div>
            </>
          )}
          {page === "import" && (
            <>
              <PageHeader
                eyebrow="EL COMIENZO DE TU PRÓXIMA CINTA"
                title="Añade algo que merezca sonar."
                text="Archivos que ya tienes, canciones que acabas de descubrir."
              />
              <div className="panel">
                <div className="tabbar">
                  {(
                    [
                      {
                        id: "links",
                        icon: Link2,
                        label: "Enlaces de YouTube",
                      },
                      {
                        id: "playlist",
                        icon: Layers3,
                        label: "Listas de reproducción",
                      },
                      {
                        id: "files",
                        icon: Upload,
                        label: "Archivos locales",
                      },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.id}
                      className={importTab === t.id ? "active" : ""}
                      onClick={() => {
                        setImportTab(t.id);
                        setResults([]);
                      }}
                    >
                      <t.icon size={17} />
                      {t.label}
                    </button>
                  ))}
                </div>
                {importTab !== "files" ? (
                  <div className="import-form">
                    <label htmlFor="links">
                      {importTab === "playlist"
                        ? "Enlace de la lista"
                        : "Enlaces de canciones"}
                    </label>
                    <textarea
                      id="links"
                      value={links}
                      onChange={(e) => setLinks(e.target.value)}
                      placeholder={
                        importTab === "playlist"
                          ? "https://www.youtube.com/playlist?list=…"
                          : "Pega aquí uno o varios enlaces, uno por línea.\nhttps://www.youtube.com/watch?v=…\nhttps://music.youtube.com/watch?v=…"
                      }
                      rows={6}
                    />
                    <p className="help">
                      {importTab === "playlist"
                        ? "Se descargará cada canción en MP3 y se creará una playlist con el nombre de la lista."
                        : "Se descargará el audio de cada canción en MP3, aunque el enlace incluya una lista."}
                    </p>
                    {importTab === "playlist" && (
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={privateList}
                          onChange={(e) => setPrivateList(e.target.checked)}
                        />
                        Es una lista privada (requiere conectar Google)
                      </label>
                    )}
                    <div className="actions">
                      <button
                        className="primary"
                        disabled={!!busy || !links.trim()}
                        onClick={() =>
                          importTab === "playlist"
                            ? void run("Leyendo lista", async () => {
                                const p = await api<Playlist>(
                                  "/playlists/preview",
                                  { url: links.trim(), private: privateList },
                                );
                                setPlaylistPreview(p);
                              })
                            : void importAction()
                        }
                      >
                        {busy ? (
                          <LoaderCircle size={17} className="spin" />
                        ) : (
                          <Plus size={17} />
                        )}{" "}
                        {importTab === "playlist"
                          ? "Previsualizar lista"
                          : "Descargar MP3 e importar"}
                      </button>
                    </div>
                    <div className="info-note">
                      <Headphones size={19} />
                      <p>
                        <strong>Todo en tu carpeta musical.</strong>
                        <br />
                        Los enlaces siempre se descargan como MP3 y se añaden a
                        la biblioteca. Solo se reproduce audio local. Descargar
                        enlaces públicos no requiere iniciar sesión.
                      </p>
                    </div>
                  </div>
                ) : (
                  <LocalImport
                    disabled={active || state.scan.running}
                    onAdded={async () => {
                      await refresh();
                      setNotice(
                        "Ubicaciones añadidas. Estamos analizando los originales sin copiarlos.",
                      );
                    }}
                  />
                )}
                {!!results.length && (
                  <div className="result-list">
                    {results.map((r, i) => (
                      <div key={i} className={r.error ? "failure" : ""}>
                        {r.error ? (
                          <AlertCircle size={16} />
                        ) : (
                          <Check size={16} />
                        )}
                        <span>{r.name ?? r.url}</span>
                        <small>
                          {r.error ??
                            (r.duplicate
                              ? "Ya estaba en tu biblioteca"
                              : "Añadido")}
                        </small>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <Jobs
                jobs={state.jobs}
                cancel={(id) =>
                  void run("Cancelando", async () => {
                    await api("/downloads/cancel", { id });
                  })
                }
                retry={(j) =>
                  void run("Reintentando", async () => {
                    await api("/downloads", { urls: [j.url] });
                  })
                }
              />
            </>
          )}
          {page === "plans" && (
            <>
              <PageHeader
                eyebrow="CADA CANCIÓN, EN SU SITIO"
                title="Dos caras. Una buena selección."
                text="Elige la cinta, afina las pausas y deja que las canciones encuentren su sitio."
              />
              <div className="plan-layout">
                <section className="panel config-panel">
                  <h3>
                    <SlidersHorizontal size={18} />
                    Prepara tu cinta
                  </h3>
                  <label>Duración del casete</label>
                  <div className="profile-picker">
                    {([60, 90] as const).map((v) => (
                      <button
                        key={v}
                        className={config.profile === v ? "active" : ""}
                        onClick={() => setConfig((c) => ({ ...c, profile: v }))}
                      >
                        <Tape size={22} />
                        <strong>C{v}</strong>
                        <span>{v / 2} min por cara</span>
                      </button>
                    ))}
                  </div>
                  <div className="form-grid">
                    <NumberField
                      label="Silencio inicial (s)"
                      value={config.initialMs / 1000}
                      min={2}
                      change={(v) =>
                        setConfig((c) => ({ ...c, initialMs: v * 1000 }))
                      }
                    />
                    <NumberField
                      label="Entre canciones (s)"
                      value={config.gapMs / 1000}
                      min={2}
                      change={(v) =>
                        setConfig((c) => ({ ...c, gapMs: v * 1000 }))
                      }
                    />
                    <NumberField
                      label="Silencio final (s)"
                      value={config.finalMs / 1000}
                      min={0}
                      change={(v) =>
                        setConfig((c) => ({ ...c, finalMs: v * 1000 }))
                      }
                    />
                    <NumberField
                      label="Reserva por cara (s)"
                      value={config.reserveMs / 1000}
                      min={0}
                      change={(v) =>
                        setConfig((c) => ({ ...c, reserveMs: v * 1000 }))
                      }
                    />
                  </div>
                  <p className="help">
                    La reserva deja margen; no se reproduce como silencio.
                  </p>
                  <label>Cómo organizar</label>
                  <select
                    value={config.mode}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        mode: e.target.value as PlanConfig["mode"],
                      }))
                    }
                  >
                    <option value="optimize">Mezclar y equilibrar</option>
                    <option value="order">Conservar el orden</option>
                  </select>
                  <label>Número de cintas</label>
                  <select
                    value={config.maxTapes ?? ""}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        maxTapes: e.target.value
                          ? Number(e.target.value)
                          : null,
                      }))
                    }
                  >
                    <option value="">Las que hagan falta</option>
                    {[1, 2, 3, 4, 5, 10].map((n) => (
                      <option key={n} value={n}>
                        {n} {n === 1 ? "cinta" : "cintas"}
                      </option>
                    ))}
                  </select>
                  <label>Fuente de la selección</label>
                  <select
                    value={playlistId}
                    onChange={(e) => setPlaylistId(e.target.value)}
                  >
                    <option value="">Biblioteca</option>
                    {state.playlists.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  {playlistId && (
                    <label className="check-label">
                      <input
                        type="checkbox"
                        checked={keepRepeats}
                        onChange={(e) => setKeepRepeats(e.target.checked)}
                      />
                      Conservar repeticiones de la lista
                    </label>
                  )}
                  <div className="config-actions">
                    <button
                      className="primary"
                      disabled={workerBusy || active}
                      onClick={() =>
                        void generate(playlistId ? "playlist" : "all")
                      }
                    >
                      {workerBusy ? (
                        <LoaderCircle className="spin" size={17} />
                      ) : (
                        <Tape size={17} />
                      )}
                      Organizar {playlistId ? "lista" : "toda la biblioteca"}
                    </button>
                    <button
                      className="secondary"
                      disabled={!selected.size || workerBusy || active}
                      onClick={() => void generate("selected")}
                    >
                      Organizar seleccionadas ({selected.size})
                    </button>
                    <button
                      className="text-button"
                      disabled={workerBusy || active}
                      onClick={() => {
                        const seed = Date.now();
                        setConfig((c) => ({ ...c, seed }));
                        setNotice(
                          "Nueva mezcla preparada. Pulsa organizar para crear otra combinación.",
                        );
                      }}
                    >
                      <Shuffle size={15} />
                      Nueva mezcla
                    </button>
                    {workerBusy && (
                      <button className="secondary" onClick={cancelGenerate}>
                        Cancelar reparto
                      </button>
                    )}
                  </div>
                </section>
                <div className="plan-results">
                  {plan ? (
                    <>
                      <div className="section-header">
                        <div>
                          <h2>{plan.name}</h2>
                          <p className="help">
                            {new Set(plan.sides.map((s) => s.tape)).size}{" "}
                            {new Set(plan.sides.map((s) => s.tape)).size === 1
                              ? "cinta"
                              : "cintas"}
                            · {nonemptySides.length}{" "}
                            {nonemptySides.length === 1 ? "cara" : "caras"} ·{" "}
                            {plan.config.mode === "order"
                              ? "Orden conservado"
                              : plan.optimality === "proven"
                                ? "Óptimo demostrado"
                                : "Reparto válido; óptimo no demostrado"}
                          </p>
                        </div>
                        <div className="plan-export-actions">
                          <button
                            className="secondary"
                            onClick={() =>
                              void run("Guardando cinta", async () => {
                                await api("/plans", plan);
                                setNotice("Selección guardada.");
                              })
                            }
                          >
                            <Check size={16} />
                            Guardar selección
                          </button>
                          <CoverButton plan={plan} />
                        </div>
                      </div>
                      <input
                        className="plan-name"
                        aria-label="Nombre de la selección"
                        value={plan.name}
                        onChange={(e) =>
                          setPlan((p) =>
                            p ? { ...p, name: e.target.value } : null,
                          )
                        }
                        disabled={active}
                      />
                      {plan.sides.map((side) => (
                        <div className="side-card" key={side.id}>
                          <div className="side-heading">
                            <div>
                              <span className="face-badge">{side.face}</span>
                              <strong>
                                Cinta {side.tape} · Cara {side.face}
                              </strong>
                            </div>
                            <span>
                              {displayTime(side.programMs)}{" "}
                              <small>/ {plan.config.profile / 2}:00</small>
                            </span>
                          </div>
                          <div className="capacity-bar">
                            <div
                              className="music-part"
                              style={{
                                width: `${(side.tracks.reduce((s, t) => s + t.durationMs, 0) / (plan.config.profile * 30000)) * 100}%`,
                              }}
                            />
                            <div
                              className="silence-part"
                              style={{
                                width: `${((side.programMs - side.tracks.reduce((s, t) => s + t.durationMs, 0)) / (plan.config.profile * 30000)) * 100}%`,
                              }}
                            />
                          </div>
                          <div className="capacity-legend">
                            <span>
                              <i />
                              Música y pausas
                            </span>
                            <span>
                              {displayTime(side.freeMs)} libres ·{" "}
                              {side.tracks.length
                                ? plan.config.reserveMs / 1000
                                : 0}
                              s de reserva
                            </span>
                          </div>
                          <div className="side-actions">
                            <button
                              className="secondary"
                              disabled={active || workerBusy}
                              aria-label={`Añadir canciones a cinta ${side.tape} cara ${side.face}`}
                              onClick={() => setAddSide(side.id)}
                            >
                              <Plus size={15} /> Añadir canciones
                            </button>
                            <button
                              className="text-button"
                              disabled={active || workerBusy}
                              aria-label={`Exportar caras de cinta ${side.tape} desde cara ${side.face}`}
                              onClick={() => setCopySide(side.id)}
                            >
                              <Tape size={15} /> Exportar caras
                            </button>
                          </div>
                          {side.tracks.length ? (
                            <ol className="side-tracks">
                              {side.tracks.map((t, i) => (
                                <li key={t.id}>
                                  <>
                                    <SongButton
                                      trackId={t.trackId}
                                      sourceId={t.sourceId}
                                      title={t.title}
                                    />
                                    <SongPlaylistButton
                                      trackId={t.trackId}
                                      sourceId={t.sourceId}
                                      title={t.title}
                                    />
                                  </>
                                  <span className="track-index">
                                    {String(i + 1).padStart(2, "0")}
                                  </span>
                                  <div>
                                    <strong>{t.title}</strong>
                                    <small>{t.artist || " "}</small>
                                  </div>
                                  <span className="source-tag">
                                    {t.kind === "local"
                                      ? "Audio local"
                                      : "YouTube"}
                                  </span>
                                  <button
                                    className="icon-button"
                                    aria-label={`Detalles de ${t.title}`}
                                    title="Editar canción"
                                    disabled={
                                      active ||
                                      workerBusy ||
                                      !trackMap.has(t.trackId)
                                    }
                                    onClick={() =>
                                      setDetail(trackMap.get(t.trackId) ?? null)
                                    }
                                  >
                                    <FilePenLine size={16} />
                                  </button>
                                  <button
                                    className="icon-button danger-text"
                                    disabled={active || workerBusy}
                                    title="Quitar de esta cara"
                                    aria-label={`Quitar ${t.title} de la cara ${side.id}`}
                                    onClick={() => {
                                      if (active || workerBusy) return;
                                      try {
                                        setPlan(removeOccurrence(plan, t.id));
                                        setSideIndex(0);
                                        setNotice(
                                          "Canción quitada de la cara. Sigue en la biblioteca. Guarda la selección para conservar el cambio.",
                                        );
                                      } catch (e) {
                                        setError(
                                          e instanceof Error
                                            ? e.message
                                            : "No se pudo quitar la canción.",
                                        );
                                      }
                                    }}
                                  >
                                    <X size={16} />
                                  </button>
                                  {!active && (
                                    <div className="track-order-controls">
                                      <button
                                        className="icon-button"
                                        aria-label={`Subir ${t.title}`}
                                        disabled={i === 0}
                                        onClick={() =>
                                          editPlan(t.id, side.id, -1)
                                        }
                                      >
                                        ↑
                                      </button>
                                      <button
                                        className="icon-button"
                                        aria-label={`Bajar ${t.title}`}
                                        disabled={i === side.tracks.length - 1}
                                        onClick={() =>
                                          editPlan(t.id, side.id, 1)
                                        }
                                      >
                                        ↓
                                      </button>
                                      <select
                                        aria-label={`Mover ${t.title} a otra cara`}
                                        value={side.id}
                                        onChange={(e) =>
                                          editPlan(t.id, e.target.value)
                                        }
                                      >
                                        {plan.sides.map((destination) => (
                                          <option
                                            key={destination.id}
                                            value={destination.id}
                                          >
                                            {destination.tape}
                                            {destination.face}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                  )}
                                  <span>{displayTime(t.durationMs)}</span>
                                </li>
                              ))}
                            </ol>
                          ) : (
                            <p className="help">Esta cara queda libre.</p>
                          )}
                          {side.tracks.length > 0 && (
                            <button
                              className="secondary record-button"
                              disabled={active}
                              onClick={() => {
                                setSideIndex(
                                  nonemptySides.findIndex(
                                    (s) => s.id === side.id,
                                  ),
                                );
                                setRecordConfirm(true);
                              }}
                            >
                              <Play size={15} />
                              Reproducir cara {side.face}
                            </button>
                          )}
                        </div>
                      ))}
                      {!!plan.excluded.length && (
                        <div className="panel excluded">
                          <h3>{plan.excluded.length} canciones pendientes</h3>
                          {plan.excluded.map((t) => (
                            <p key={t.id}>
                              <>
                                <SongButton
                                  trackId={
                                    trackMap.has(t.id)
                                      ? t.id
                                      : (state.playlists
                                          .flatMap((p) => p.items)
                                          .find((i) => i.id === t.id)
                                          ?.trackId ?? undefined)
                                  }
                                  title={t.title}
                                />
                                <SongPlaylistButton
                                  trackId={
                                    trackMap.has(t.id)
                                      ? t.id
                                      : (state.playlists
                                          .flatMap((p) => p.items)
                                          .find((i) => i.id === t.id)
                                          ?.trackId ?? undefined)
                                  }
                                  title={t.title}
                                />
                              </>
                              <strong>{t.title}</strong>
                              <span>{t.reason}</span>
                            </p>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="panel plan-empty">
                      <Cassette profile={config.profile} small />
                      <h3>Tu próxima cinta empieza aquí.</h3>
                      <p>
                        Organiza tu biblioteca o selecciona unas canciones.
                        <br />
                        Calcularemos los huecos, las caras y las pausas.
                      </p>
                    </div>
                  )}
                </div>
              </div>
              {state.plans.length > 0 && (
                <section className="saved-plans">
                  <div className="section-header">
                    <h2>Guardadas para otro momento</h2>
                    <span>{state.plans.length} selecciones</span>
                  </div>
                  <div className="saved-grid">
                    {state.plans.map((p) => (
                      <button
                        className="saved-card"
                        key={p.id}
                        disabled={active}
                        onClick={() => {
                          setPlan(p);
                          setConfig(p.config);
                          setSideIndex(0);
                        }}
                      >
                        <Tape size={26} />
                        <div>
                          <strong>{p.name}</strong>
                          <small>
                            {new Date(p.createdAt).toLocaleDateString("es")} ·{" "}
                            {p.sides.filter((s) => s.tracks.length).length}{" "}
                            {p.sides.filter((s) => s.tracks.length).length === 1
                              ? "cara"
                              : "caras"}
                          </small>
                        </div>
                        <ArrowRight size={17} />
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
          {page === "folder" && (
            <>
              <PageHeader
                eyebrow="UN LUGAR PARA TU MÚSICA"
                title="Todo en su sitio."
                text="Tu carpeta es la fuente. El catálogo te ayuda a cuidarla."
              />
              <div className="panel folder-panel">
                <div className="folder-header">
                  <div className="folder-icon">
                    <FolderOpen size={30} />
                  </div>
                  <div>
                    <h3>Carpeta para nuevas descargas</h3>
                    <code>{state.root.path}</code>
                    <p className="help">
                      {state.root.connected ? "Conectada" : "Desconectada"} ·{" "}
                      {state.root.writable
                        ? "Lectura y escritura"
                        : "Solo lectura"}
                    </p>
                  </div>
                  <button
                    className="secondary"
                    disabled={state.scan.running || !!busy}
                    onClick={() =>
                      void run("Escaneando", async () => {
                        await api("/scan", { full: true });
                      })
                    }
                  >
                    <RefreshCw
                      size={16}
                      className={state.scan.running ? "spin" : ""}
                    />
                    {state.scan.running
                      ? `${state.scan.processed} analizados`
                      : "Actualizar biblioteca"}
                  </button>
                </div>
                <div className="folder-change">
                  <label htmlFor="root-path">
                    Cambiar destino de descargas y añadirlo a la biblioteca
                  </label>
                  <div className="input-action">
                    <input
                      id="root-path"
                      value={rootPath}
                      onChange={(e) => setRootPath(e.target.value)}
                      placeholder="/Users/tu-usuario/Music"
                    />
                    <button
                      className="secondary"
                      disabled={!rootPath.trim() || active}
                      onClick={() =>
                        void run("Comprobando carpeta", async () =>
                          setRootPreview(
                            await api("/root/preview", { path: rootPath }),
                          ),
                        )
                      }
                    >
                      Revisar carpeta
                      <ArrowRight size={16} />
                    </button>
                  </div>
                  <p className="help">
                    Indexaremos MP3, WAV y FLAC en sus subcarpetas. Elegir otra
                    carpeta no mueve ni borra tus archivos.
                  </p>
                </div>
                {!!state.scan.errors.length && (
                  <div className="result-list">
                    {state.scan.errors.slice(0, 20).map((e, i) => (
                      <p key={i} className="error-text">
                        {e}
                      </p>
                    ))}
                  </div>
                )}
              </div>
              <section className="panel library-origins">
                <h3>Archivos y carpetas de la biblioteca</h3>
                <p className="help">
                  Se leen y reproducen en su ubicación original. Las carpetas
                  incluyen sus subcarpetas; los archivos sueltos no incluyen sus
                  vecinos.
                </p>
                <ul>
                  {state.libraryPaths.map((e) => (
                    <li key={e.path}>
                      <strong>
                        {e.kind === "folder" ? "Carpeta" : "Archivo"}
                      </strong>
                      <code>{e.path}</code>
                    </li>
                  ))}
                </ul>
                <button
                  className="secondary"
                  onClick={() => {
                    setPage("import");
                    setImportTab("files");
                  }}
                >
                  Añadir archivos o carpetas
                </button>
              </section>
              <div className="section-header">
                <div>
                  <h2>Copias idénticas</h2>
                  <p className="help">
                    Una canción en la biblioteca. Cada archivo conserva su
                    ubicación.
                  </p>
                </div>
                <span className="count-badge">{duplicateTracks.length}</span>
              </div>
              {duplicateTracks.length ? (
                <div className="panel">
                  {duplicateTracks.map((t) => (
                    <div className="duplicate-row" key={t.id}>
                      <>
                        <SongButton trackId={t.id} title={t.title} />
                        <SongPlaylistButton trackId={t.id} title={t.title} />
                      </>
                      <div>
                        <strong>{t.title}</strong>
                        {t.sources
                          .flatMap((s) =>
                            s.locations.filter((l) => l.available),
                          )
                          .map((l) => (
                            <small key={l.id}>
                              {l.absolutePath ?? l.relativePath}
                            </small>
                          ))}
                      </div>
                      <button
                        className="secondary"
                        onClick={() => setDetail(t)}
                      >
                        Revisar archivos
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="panel compact-empty">
                  <CheckCircle2 size={22} />
                  <p>No se han encontrado copias exactas en tu carpeta.</p>
                </div>
              )}
              {state.tracks.some((t) =>
                t.sources.some((s) => s.locations.some((l) => l.trashed)),
              ) && (
                <section className="trash-section">
                  <h2>Papelera recuperable</h2>
                  <div className="panel">
                    {state.tracks.flatMap((t) =>
                      t.sources.flatMap((s) =>
                        s.locations
                          .filter((l) => l.trashed)
                          .map((l) => (
                            <div className="duplicate-row" key={l.id}>
                              <>
                                <SongButton
                                  trackId={t.id}
                                  sourceId={s.id}
                                  title={t.title}
                                />
                                <SongPlaylistButton
                                  trackId={t.id}
                                  sourceId={s.id}
                                  title={t.title}
                                />
                              </>
                              <div>
                                <strong>{l.name}</strong>
                                <small>No se borrará automáticamente.</small>
                              </div>
                              <button
                                className="secondary"
                                onClick={() =>
                                  void run("Preparando restauración", () =>
                                    previewFile(l.id, "restore"),
                                  )
                                }
                              >
                                <RotateCcw size={16} />
                                Restaurar
                              </button>
                            </div>
                          )),
                      ),
                    )}
                  </div>
                </section>
              )}
              {hiddenCount > 0 && (
                <div className="panel hidden-panel">
                  <h3>{hiddenCount} canciones fuera de la biblioteca</h3>
                  <p>Siguen en el disco. Puedes volver a incluirlas.</p>
                  <button
                    className="secondary"
                    onClick={() =>
                      void run("Restaurando catálogo", async () => {
                        await api("/tracks/visibility", {
                          ids: state.tracks
                            .filter((t) => t.hidden)
                            .map((t) => t.id),
                          hidden: false,
                        });
                      })
                    }
                  >
                    Volver a incluir todas
                  </button>
                </div>
              )}
              {state.operations.length > 0 && (
                <section className="operation-history">
                  <h2>Historial de cambios</h2>
                  <div className="panel">
                    {state.operations
                      .filter((o) => o.status !== "planned")
                      .slice(0, 20)
                      .map((o) => (
                        <div className="history-row" key={o.id}>
                          <span>
                            {o.action === "rename"
                              ? "Renombrar"
                              : o.action === "trash"
                                ? "Retirar"
                                : "Restaurar"}
                          </span>
                          <code>
                            {o.from} → {o.to}
                          </code>
                          <small>
                            {o.status === "committed"
                              ? "Completado"
                              : (o.error ?? o.status)}
                          </small>
                        </div>
                      ))}
                  </div>
                </section>
              )}
            </>
          )}
          {page === "settings" && (
            <>
              <PageHeader
                eyebrow="A TU MANERA"
                title="Un poco de precisión."
                text="Todo lo necesario para preparar tu próxima sesión."
              />
              <div className="settings-grid">
                <section className="panel settings-card">
                  <h3>
                    <Link2 size={20} />
                    Cuenta de YouTube
                  </h3>
                  <p>
                    Opcional, para consultar tus listas privadas. La sesión se
                    mantiene en memoria mientras el servidor está abierto.
                  </p>
                  <span
                    className={`status-chip ${state.google.connected ? "green" : ""}`}
                  >
                    {state.google.connected
                      ? "Cuenta conectada"
                      : state.google.configured
                        ? "Lista para conectar"
                        : "Sin configurar"}
                  </span>
                  {!state.google.configured && (
                    <p className="help">
                      Configura GOOGLE_CLIENT_ID en .env. El retorno es
                      http://127.0.0.1:4310/api/google/callback.
                    </p>
                  )}
                  <button
                    className="secondary"
                    disabled={!!busy || !state.google.configured}
                    onClick={() =>
                      void run("Conectando cuenta", async () => {
                        if (state.google.connected) {
                          await api("/google/disconnect", {});
                          setNotice(
                            "Cuenta desconectada. Tus MP3 se conservan.",
                          );
                        } else {
                          const r = await api<{ url: string }>(
                            "/google/connect",
                          );
                          window.open(r.url, "_blank", "noopener,noreferrer");
                        }
                      })
                    }
                  >
                    {state.google.connected
                      ? "Desconectar Google"
                      : "Conectar Google"}
                    <ArrowRight size={15} />
                  </button>
                  <p className="help">
                    Google solo se utiliza para consultar listas accesibles a tu
                    cuenta. La aplicación reproduce archivos locales; las
                    descargas públicas no requieren sesión ni Premium.
                  </p>
                </section>
                <section className="panel settings-card">
                  <h3>
                    <Download size={20} />
                    Herramientas de audio
                  </h3>
                  <p>
                    Descarga de enlaces públicos sin iniciar sesión y conversión
                    a MP3 a 320 kb/s.
                  </p>
                  <div className="tool-status">
                    <span>yt-dlp</span>
                    <strong>
                      {state.audio.downloader ? "Disponible" : "No instalado"}
                    </strong>
                  </div>
                  <div className="tool-status">
                    <span>FFmpeg</span>
                    <strong>
                      {state.audio.ffmpeg ? "Disponible" : "No instalado"}
                    </strong>
                  </div>
                  <p className="help">
                    Instalación local: <code>npm run setup:audio</code>
                  </p>
                  <p className="help">
                    320 kb/s es el perfil de salida, no una mejora de la calidad
                    del original.
                  </p>
                </section>
                <section className="panel settings-card">
                  <h3>
                    <Folder size={20} />
                    Copias y biblioteca
                  </h3>
                  <p>
                    Exporta el catálogo o crea una copia que también incluya los
                    archivos musicales.
                  </p>
                  <div className="actions vertical">
                    <a className="secondary" href="/api/export" download>
                      <ArrowDownToLine size={16} />
                      Exportar catálogo JSON
                    </a>
                    <button
                      className="secondary"
                      onClick={() => restoreInput.current?.click()}
                    >
                      <Upload size={16} />
                      Importar copia JSON
                    </button>
                    <button
                      className="secondary"
                      disabled={!!busy || active}
                      onClick={() =>
                        void run("Copiando biblioteca y audio", async () => {
                          const r = await api<{
                            path: string;
                            files: number;
                          }>("/backup", {});
                          setNotice(
                            `Copia creada: ${r.path} · ${r.files} archivos.`,
                          );
                        })
                      }
                    >
                      Crear copia con archivos
                    </button>
                  </div>
                  <p className="help">
                    El JSON no incluye audio ni credenciales. Las referencias
                    privadas se excluyen de las copias exportables.
                  </p>
                </section>
                <section className="panel settings-card">
                  <h3>
                    <Tape size={20} />
                    Antes de grabar
                  </h3>
                  <ol className="preflight-list">
                    <li>
                      Conecta la salida de audio del ordenador a tu grabadora.
                    </li>
                    <li>Pasa la cinta guía y comprueba los niveles.</li>
                    <li>
                      Desactiva notificaciones y suspensión del ordenador.
                    </li>
                    <li>Inicia la grabadora y reproduce la cara preparada.</li>
                  </ol>
                  <p className="help">
                    La aplicación no controla la grabadora física. Una pausa en
                    pantalla no detiene la cinta.
                  </p>
                </section>
              </div>
            </>
          )}
        </div>
        <footer className="app-footer">
          <span>
            CASSETTES <span className="footer-dot">●</span> EL PLACER DE HACER
            UNA SELECCIÓN.
          </span>
          <span>Local. Personal. A tu ritmo.</span>
        </footer>
      </main>
      {(active ||
        playback.status === "completed" ||
        playback.status === "error") && (
        <div
          className={`recording-bar ${playback.status === "error" ? "record-error" : ""}`}
        >
          <div className="recording-indicator">
            <i className={playback.status === "playing" ? "pulse" : ""} />
          </div>
          <div className="now-playing">
            <small>
              {playback.status === "preparing"
                ? "PREPARANDO AUDIO"
                : playback.status === "paused"
                  ? "EN PAUSA"
                  : playback.status === "completed"
                    ? "CARA TERMINADA"
                    : playback.status === "error"
                      ? "SESIÓN INTERRUMPIDA"
                      : `CINTA ${currentSide?.tape} · CARA ${currentSide?.face}`}
            </small>
            <strong>{playback.error || playback.title}</strong>
          </div>
          <span className="record-time">{displayTime(playback.elapsedMs)}</span>
          <div className="record-controls">
            {playback.status === "completed" &&
              sideIndex < nonemptySides.length - 1 && (
                <button
                  className="secondary"
                  onClick={() => {
                    setSideIndex((i) => i + 1);
                    setRecordConfirm(true);
                  }}
                >
                  Siguiente cara
                  <ArrowRight size={15} />
                </button>
              )}
            {playback.status === "playing" && (
              <button
                className="icon-button"
                aria-label="Pausar reproducción"
                onClick={() => void recorder.current?.pause()}
              >
                <Pause />
              </button>
            )}
            {playback.status === "paused" && (
              <button
                className="icon-button"
                aria-label="Continuar reproducción"
                onClick={() => void recorder.current?.resume()}
              >
                <Play />
              </button>
            )}
            <button
              className="icon-button"
              aria-label="Detener sesión"
              onClick={() => void recorder.current?.stop()}
            >
              <Square size={20} />
            </button>
          </div>
        </div>
      )}
      <MusicBar />
      <input
        ref={restoreInput}
        type="file"
        accept=".json"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file)
            void run("Leyendo copia", async () => {
              const data: unknown = JSON.parse(await file.text());
              setRestorePreview(await api("/restore/preview", data));
            });
          e.target.value = "";
        }}
      />
      {rootPreview && (
        <Modal
          title="Conectar carpeta musical"
          onClose={() => setRootPreview(null)}
        >
          <p>Leeremos los archivos y subcarpetas de esta ubicación:</p>
          <code className="path-preview">{rootPreview.path}</code>
          <p className="help">
            Los archivos se indexarán donde están, sin moverlos ni crear copias.
            La carpeta anterior se conserva.
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setRootPreview(null)}>
              Cancelar
            </button>
            <button
              className="primary"
              onClick={() =>
                void run("Conectando carpeta", async () => {
                  await api("/root/confirm", { id: rootPreview.id });
                  setRootPreview(null);
                  setNotice("Carpeta conectada. Estamos analizando tu música.");
                })
              }
            >
              Conectar y escanear
            </button>
          </div>
        </Modal>
      )}
      {operation && (
        <Modal
          title={
            operation.action === "rename"
              ? "Revisar renombrado"
              : operation.action === "trash"
                ? "Retirar archivo a papelera"
                : "Restaurar archivo"
          }
          onClose={() => setOperation(null)}
        >
          <p>
            Esta operación afecta a <strong>un archivo</strong>. No se
            sobrescribirá ningún destino.
          </p>
          <div className="operation-preview">
            <small>ORIGEN</small>
            <code>{operation.from}</code>
            <ArrowDownToLine size={18} />
            <small>DESTINO</small>
            <code>{operation.to}</code>
          </div>
          <p className="help">
            {operation.action === "trash"
              ? "El archivo quedará en una papelera recuperable. Los planes sin otra copia disponible no podrán iniciarse."
              : "Las referencias de la biblioteca mantendrán su identidad."}
          </p>
          <div className="modal-actions">
            <button className="secondary" onClick={() => setOperation(null)}>
              Cancelar
            </button>
            <button
              className={operation.action === "trash" ? "danger" : "primary"}
              disabled={!!busy}
              onClick={() =>
                void run("Aplicando cambio", async () => {
                  await api("/files/apply", { id: operation.id });
                  setOperation(null);
                  setNotice("Cambio completado.");
                })
              }
            >
              Confirmar{" "}
              {operation.action === "rename"
                ? "renombrado"
                : operation.action === "trash"
                  ? "retirada"
                  : "restauración"}
            </button>
          </div>
        </Modal>
      )}
      {rename && (
        <Modal title="Nuevo nombre del archivo" onClose={() => setRename(null)}>
          <label htmlFor="rename">Nombre (conserva la extensión)</label>
          <input
            id="rename"
            value={rename.name}
            onChange={(e) =>
              setRename((r) => (r ? { ...r, name: e.target.value } : null))
            }
          />
          <div className="modal-actions">
            <button className="secondary" onClick={() => setRename(null)}>
              Cancelar
            </button>
            <button
              className="primary"
              onClick={() =>
                void run("Revisando nombre", () =>
                  previewFile(rename.locationId, "rename", rename.name),
                )
              }
            >
              Previsualizar cambio
              <ArrowRight size={15} />
            </button>
          </div>
        </Modal>
      )}
      {plan && addSide && (
        <AddSideTrackDialog
          plan={plan}
          sideId={addSide}
          tracks={state.tracks}
          sourceChoices={sourceChoices}
          onClose={() => setAddSide(null)}
          onAdd={async (track, signal) => {
            if (active || workerBusy)
              throw new Error(
                "Detén la grabación o preparación antes de editar.",
              );
            await listening.player.stop();
            signal.throwIfAborted();
            let audioWarning = false;
            const next = await prepareTrackAddition(
              plan,
              addSide,
              track,
              signal,
              sourceChoices[track.id],
              (warnings) => {
                audioWarning = warnings;
              },
            );
            signal.throwIfAborted();
            setPlan(next);
            setSideIndex(0);
            setAddSide(null);
            setNotice(
              "Canción añadida. Tiempos recalculados; guarda la selección para conservar el cambio." +
                (audioWarning
                  ? " El audio contiene errores recuperables; escucha la canción antes de grabar."
                  : ""),
            );
            void refresh().catch(() => {});
          }}
        />
      )}
      {plan && copySide && (
        <CopySidesDialog
          plan={plan}
          sideId={copySide}
          onClose={() => setCopySide(null)}
          onSave={async (next) => {
            if (active || workerBusy)
              throw new Error(
                "Detén la grabación o preparación antes de editar.",
              );
            await api("/plans", next);
            setPlan(next);
            setConfig(next.config);
            setSideIndex(0);
            setCopySide(null);
            setNotice(
              "Cinta independiente guardada. Puedes editar sus caras; la selección original se conserva.",
            );
            void refresh().catch(() => {});
          }}
        />
      )}
      {detail && (
        <Modal title="Canción y archivos" onClose={() => setDetail(null)}>
          <TrackDetail
            key={detail.id}
            track={state.tracks.find((t) => t.id === detail.id) ?? detail}
            sourceId={sourceChoices[detail.id]}
            choose={(id) =>
              setSourceChoices((v) => ({ ...v, [detail.id]: id }))
            }
            save={async (changes) => {
              await api("/tracks/edit", { id: detail.id, ...changes });
              setPlan((current) =>
                current
                  ? updatePlanTrackMetadata(current, detail.id, changes)
                  : null,
              );
              await refresh();
            }}
            rename={(locationId, name) => {
              setDetail(null);
              setRename({ locationId, name });
            }}
            trash={(id) =>
              void run("Preparando retirada", () => previewFile(id, "trash"))
            }
          />
        </Modal>
      )}
      {playlistPreview && (
        <Modal
          title="Revisar lista de reproducción"
          onClose={() => setPlaylistPreview(null)}
        >
          <h3>{playlistPreview.name}</h3>
          <p>
            {playlistPreview.items.length} entradas ·{" "}
            {playlistPreview.items.filter((i) => !i.trackId).length}{" "}
            inaccesibles
            {playlistPreview.partial
              ? " · Lista parcial: límite de 1 000 entradas"
              : ""}
          </p>
          <ol className="playlist-preview">
            {playlistPreview.items.map((i) => (
              <li key={i.id}>
                <>
                  <SongButton
                    trackId={i.trackId ?? undefined}
                    title={i.title}
                  />
                  <SongPlaylistButton
                    trackId={i.trackId ?? undefined}
                    title={i.title}
                  />
                </>
                {i.title}
                {!i.trackId && <small> No disponible</small>}
              </li>
            ))}
          </ol>
          <div className="modal-actions">
            <button
              className="secondary"
              onClick={() => setPlaylistPreview(null)}
            >
              Cancelar
            </button>
            <button
              className="primary"
              onClick={() =>
                void run("Importando lista", async () => {
                  const imported = await api<Playlist>("/playlists/confirm", {
                    id: playlistPreview.id,
                  });
                  setPlaylistId(imported.id);
                  setPlaylistPreview(null);
                  setPage("playlists");
                  setNotice(
                    `Playlist «${imported.name}» creada. Descargando sus canciones en MP3.`,
                  );
                })
              }
            >
              Descargar MP3 y crear playlist
            </button>
          </div>
        </Modal>
      )}
      {restorePreview && (
        <Modal
          title="Revisar importación del catálogo"
          onClose={() => setRestorePreview(null)}
        >
          <p>
            {restorePreview.tracks} canciones · {restorePreview.plans} planes
          </p>
          <p>{restorePreview.message}</p>
          <div className="modal-actions">
            <button
              className="secondary"
              onClick={() => setRestorePreview(null)}
            >
              Cancelar
            </button>
            <button
              className="primary"
              onClick={() =>
                void run("Restaurando catálogo", async () => {
                  await api("/restore/confirm", { id: restorePreview.id });
                  setRestorePreview(null);
                  setNotice(
                    "Catálogo importado. Revisa la disponibilidad de sus archivos.",
                  );
                })
              }
            >
              Añadir al catálogo
            </button>
          </div>
        </Modal>
      )}
      {recordConfirm && currentSide && plan && (
        <Modal
          title={`Preparar cinta ${currentSide.tape} · cara ${currentSide.face}`}
          onClose={() => setRecordConfirm(false)}
        >
          <Cassette profile={plan.config.profile} small />
          <p>
            Prepara la grabadora, pasa la cinta guía y comprueba los niveles. Se
            reproducirán <strong>{currentSide.tracks.length} canciones</strong>{" "}
            con sus silencios.
          </p>
          <p className="help">
            Comprobaremos y cargaremos todo el audio local antes de empezar.{" "}
            Pausar la aplicación no detiene la cinta física.
          </p>
          <div className="modal-actions">
            <button
              className="secondary"
              onClick={() => setRecordConfirm(false)}
            >
              Aún no
            </button>
            <button
              className="primary"
              onClick={() => {
                setRecordConfirm(false);
                setStartingRecording(true);
                void (async () => {
                  try {
                    await listening.player.stop();
                    await recorder.current?.start(currentSide, plan.config);
                  } finally {
                    setStartingRecording(false);
                  }
                })();
              }}
            >
              <Play size={16} />
              Reproducir esta cara
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
  return (
    <MusicContext.Provider
      value={{
        ...listening,
        tracks: trackMap,
        choices: sourceChoices,
        disabled: active || startingRecording || workerBusy,
        beforeListen: () => {
          if (!active) void recorder.current?.stop();
        },
      }}
    >
      <PlaylistProvider playlists={state.playlists} refresh={refresh}>
        {content}
      </PlaylistProvider>
    </MusicContext.Provider>
  );
}
function PageHeader({
  eyebrow,
  title,
  text,
}: {
  eyebrow: string;
  title: string;
  text: string;
}) {
  return (
    <div className="page-heading">
      <div className="eyebrow muted">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{text}</p>
    </div>
  );
}
function NumberField({
  label,
  value,
  min,
  change,
}: {
  label: string;
  value: number;
  min: number;
  change: (v: number) => void;
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={3600}
        step={1}
        onChange={(e) => change(Number(e.target.value))}
      />
    </label>
  );
}
function TrackRow({
  track: t,
  selected,
  toggle,
  detail,
  filterBy,
}: {
  track: Track;
  selected: boolean;
  toggle: () => void;
  detail: () => void;
  filterBy: (field: LibraryFilter, value: string) => void;
}) {
  const s = chooseSource(t);
  return (
    <tr className={selected ? "selected" : ""}>
      <td className="checkbox-cell">
        <input
          type="checkbox"
          checked={selected}
          onChange={toggle}
          aria-label={`Seleccionar ${t.title}`}
        />
      </td>
      <td>
        <div className="track-title">
          <>
            <SongButton trackId={t.id} title={t.title} />
            <SongPlaylistButton trackId={t.id} title={t.title} />
          </>
          <button
            className="track-info"
            onClick={detail}
            aria-label={`Ver ${t.title}`}
          >
            <span>
              <strong>{t.title}</strong>
              <small>
                {s?.locations.find((l) => l.available)?.name ??
                  (s?.kind === "youtube"
                    ? "Referencia de YouTube"
                    : "Archivo no disponible")}
              </small>
            </span>
          </button>
        </div>
      </td>
      <td className="optional-column">
        {t.artist ? (
          <button
            className="metadata-filter"
            title={`Ver todas las canciones de ${t.artist}`}
            aria-label={`Filtrar por artista: ${t.artist}`}
            onClick={() => filterBy("artist", t.artist)}
          >
            {t.artist}
          </button>
        ) : (
          <span className="unknown">—</span>
        )}
      </td>
      <td className="optional-column">
        {t.album ? (
          <button
            className="metadata-filter"
            title={`Ver todas las canciones del álbum ${t.album}`}
            aria-label={`Filtrar por álbum: ${t.album}`}
            onClick={() => filterBy("album", t.album)}
          >
            {t.album}
          </button>
        ) : (
          <span className="unknown">—</span>
        )}
      </td>
      <td className="genre-column">
        {t.genres.length ? (
          <div className="track-genres">
            {t.genres.map((g) => (
              <button
                key={g}
                className="genre-tag metadata-filter"
                aria-label={`Filtrar por género: ${g}`}
                title={`Ver todas las canciones de ${g}`}
                onClick={() => filterBy("genre", g)}
              >
                {g}
              </button>
            ))}
          </div>
        ) : (
          <span className="unknown">—</span>
        )}
      </td>
      <td className="duration">
        {s?.durationMs ? displayTime(s.durationMs) : "—"}
      </td>
      <td>
        <span className={`source-tag ${s?.kind === "local" ? "green" : ""}`}>
          {s?.available
            ? s.kind === "local"
              ? "Local"
              : "YouTube"
            : "No disponible"}
        </span>
        {(s?.locations.filter((l) => l.available).length ?? 0) > 1 && (
          <small className="copies">
            {s?.locations.filter((l) => l.available).length} copias
          </small>
        )}
      </td>
      <td>
        <button
          className="icon-button"
          aria-label={`Detalles de ${t.title}`}
          onClick={detail}
        >
          <FilePenLine size={16} />
        </button>
      </td>
    </tr>
  );
}
function GroupRows({
  groupField,
  label,
  tracks,
  selected,
  toggle,
  detail,
  filterBy,
}: {
  label: string;
  tracks: Track[];
  selected: Set<string>;
  toggle: (id: string) => void;
  detail: (t: Track) => void;
  filterBy: (field: LibraryFilter, value: string) => void;
  groupField?: LibraryFilter;
}) {
  return (
    <>
      <tr className="group-row">
        <td colSpan={8}>
          {groupField &&
          tracks.some((t) =>
            groupField === "genre"
              ? t.genres.includes(label)
              : t[groupField] === label,
          ) ? (
            <button
              className="metadata-filter"
              aria-label={`Filtrar grupo: ${label}`}
              onClick={() => filterBy(groupField, label)}
            >
              {label}
            </button>
          ) : (
            label
          )}
          <span>{tracks.length}</span>
        </td>
      </tr>
      {tracks.map((t) => (
        <TrackRow
          key={t.id}
          track={t}
          selected={selected.has(t.id)}
          toggle={() => toggle(t.id)}
          detail={() => detail(t)}
          filterBy={filterBy}
        />
      ))}
    </>
  );
}
function TrackDetail({
  track,
  sourceId,
  choose,
  save,
  rename,
  trash,
}: {
  track: Track;
  sourceId?: string;
  choose: (id: string) => void;
  save: (v: {
    title: string;
    artist: string;
    album: string;
    genres: string[];
  }) => Promise<void>;
  rename: (id: string, name: string) => void;
  trash: (id: string) => void;
}) {
  const [title, setTitle] = useState(track.title),
    [artist, setArtist] = useState(track.artist),
    [album, setAlbum] = useState(track.album),
    [genre, setGenre] = useState(track.genres.join(", "));
  const [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState(""),
    [saved, setSaved] = useState(false);
  return (
    <div
      className="track-detail"
      onChange={() => {
        setSaved(false);
        setSaveError("");
      }}
    >
      <div className="detail-listen">
        <>
          <SongButton
            trackId={track.id}
            sourceId={sourceId}
            title={track.title}
          />
          <SongPlaylistButton
            trackId={track.id}
            sourceId={sourceId}
            title={track.title}
          />
        </>
        <span>Escuchar {track.title}</span>
      </div>
      <div className="form-grid">
        <label>
          Título
          <input
            disabled={saving}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Artista / intérprete
          <input
            disabled={saving}
            value={artist}
            onChange={(e) => setArtist(e.target.value)}
          />
        </label>
        <label>
          Álbum
          <input
            disabled={saving}
            value={album}
            onChange={(e) => setAlbum(e.target.value)}
          />
        </label>
        <label>
          Géneros (separados por coma)
          <input
            disabled={saving}
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
          />
        </label>
      </div>
      <p className="help">
        Correcciones del catálogo. No se escriben etiquetas en tus archivos.
      </p>
      <button
        className="secondary"
        disabled={saving}
        onClick={() => {
          if (saving) return;
          setSaved(false);
          setSaveError("");
          if (!title.trim()) {
            setSaveError("Escribe un título para la canción.");
            return;
          }
          setSaving(true);
          void save({
            title: title.trim(),
            artist,
            album,
            genres: genre
              .split(",")
              .map((g) => g.trim())
              .filter(Boolean),
          })
            .then(() => setSaved(true))
            .catch((e: unknown) =>
              setSaveError(
                e instanceof Error
                  ? e.message
                  : "No se pudieron guardar los datos.",
              ),
            )
            .finally(() => setSaving(false));
        }}
      >
        <Check size={16} />
        {saving ? "Guardando…" : "Guardar datos"}
      </button>
      {saved && (
        <p className="help" role="status">
          Datos guardados en la biblioteca y en las cintas. El PDF usará el
          título actualizado.
        </p>
      )}
      {saveError && (
        <p className="error-text" role="alert">
          {saveError}
        </p>
      )}
      <h3>Fuente para nuevas cintas</h3>
      {track.sources.map((s) => (
        <div className="source-detail" key={s.id}>
          <>
            <SongButton
              trackId={track.id}
              sourceId={s.id}
              title={track.title}
            />
            <SongPlaylistButton
              trackId={track.id}
              sourceId={s.id}
              title={track.title}
            />
          </>
          <label className="check-label">
            <input
              type="radio"
              name="source"
              checked={(sourceId ?? chooseSource(track)?.id) === s.id}
              disabled={!s.available}
              onChange={() => choose(s.id)}
            />
            <strong>
              {s.kind === "youtube" ? "YouTube" : "Archivo local"}
            </strong>
            <span>
              {s.durationMs
                ? displayTime(s.durationMs)
                : "Duración desconocida"}
            </span>
          </label>
          {s.locations
            .filter((l) => !l.trashed)
            .map((l) => (
              <div className="location-detail" key={l.id}>
                <code>{l.absolutePath ?? l.relativePath}</code>
                <small>
                  {(l.size / 1024 / 1024).toFixed(1)} MB ·{" "}
                  {l.available ? "Disponible" : "No disponible"}
                </small>
                <div className="actions">
                  <button
                    className="text-button"
                    disabled={!l.available}
                    onClick={() => rename(l.id, l.name)}
                  >
                    <FilePenLine size={14} />
                    Renombrar
                  </button>
                  <button
                    className="text-button danger-text"
                    disabled={!l.available}
                    onClick={() => trash(l.id)}
                  >
                    <Trash2 size={14} />
                    Retirar archivo
                  </button>
                </div>
              </div>
            ))}
          {s.kind === "youtube" && (
            <a
              className="text-button"
              href={`https://www.youtube.com/watch?v=${s.videoId}`}
              target="_blank"
              rel="noreferrer"
            >
              Abrir en YouTube
              <ArrowRight size={14} />
            </a>
          )}
        </div>
      ))}
    </div>
  );
}
function Jobs({
  jobs,
  cancel,
  retry,
}: {
  jobs: Snapshot["jobs"];
  cancel: (id: string) => void;
  retry: (job: Snapshot["jobs"][number]) => void;
}) {
  if (!jobs.length) return null;
  return (
    <section className="jobs">
      <div className="section-header">
        <h2>Del enlace a tu carpeta</h2>
        <span>
          {jobs.filter((j) => j.status === "completed").length} completadas
        </span>
      </div>
      <div className="panel">
        {jobs.slice(0, 30).map((j) => (
          <div className="job-row" key={j.id}>
            {j.status === "completed" && j.sourceId ? (
              <>
                <SongButton sourceId={j.sourceId} title={j.title} />
                <SongPlaylistButton sourceId={j.sourceId} title={j.title} />
              </>
            ) : (
              <span className="job-icon">
                {j.status === "running" ? (
                  <LoaderCircle className="spin" size={20} />
                ) : j.status === "completed" ? (
                  <CheckCircle2 size={20} />
                ) : (
                  <Download size={20} />
                )}
              </span>
            )}
            <div>
              <strong>{j.title}</strong>
              <small>
                {j.status === "queued"
                  ? "En cola"
                  : j.status === "running"
                    ? `Descargando · ${j.progress.toFixed(0)} %`
                    : j.status === "completed"
                      ? "MP3 disponible en tu carpeta"
                      : j.error}
              </small>
              {j.status === "running" && (
                <progress value={j.progress} max={100} />
              )}
            </div>
            {["queued", "running"].includes(j.status) ? (
              <button className="text-button" onClick={() => cancel(j.id)}>
                Cancelar
              </button>
            ) : j.status === "failed" || j.status === "cancelled" ? (
              <button className="text-button" onClick={() => retry(j)}>
                Reintentar
              </button>
            ) : (
              <span className="source-tag green">MP3</span>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
