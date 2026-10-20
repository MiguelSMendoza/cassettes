import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search, Check } from "lucide-react";
import type { Plan, Track } from "../domain/types";
import { displayTime } from "../domain/types";
import { copySidesToTape, fittingAdditionSource } from "../domain/edit-plan";
import { Modal } from "./Modal";

export function AddSideTrackDialog({
  plan,
  sideId,
  tracks,
  sourceChoices,
  onAdd,
  onClose,
}: {
  plan: Plan;
  sideId: string;
  tracks: Track[];
  sourceChoices: Record<string, string>;
  onAdd: (track: Track, signal: AbortSignal) => Promise<void>;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [adding, setAdding] = useState(""),
    [page, setPage] = useState(0);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const matches = useMemo(
    () =>
      tracks.flatMap((track) => {
        const source = fittingAdditionSource(
          plan,
          sideId,
          track,
          sourceChoices[track.id],
        );
        return !track.hidden &&
          source &&
          [track.title, track.artist, track.album]
            .join(" ")
            .toLocaleLowerCase("es")
            .includes(query.toLocaleLowerCase("es"))
          ? [{ track, source }]
          : [];
      }),
    [query, tracks, plan, sideId, sourceChoices],
  );
  const side = plan.sides.find((s) => s.id === sideId);
  const pages = Math.max(1, Math.ceil(matches.length / 30));
  const currentPage = Math.min(page, pages - 1);
  return (
    <Modal
      title={`Añadir a cinta ${side?.tape} · Cara ${side?.face}`}
      onClose={() => {
        abort.current?.abort();
        onClose();
      }}
    >
      <p className="help">
        {displayTime(side?.freeMs ?? 0)} libres, descontando la reserva. La
        lista muestra solo canciones que caben según su duración registrada,
        incluyendo pausas. Al añadir se comprueba el audio real.
      </p>
      <label className="side-search">
        <Search size={16} />
        <span>Buscar en la biblioteca</span>
        <input
          autoFocus
          type="search"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(0);
          }}
          placeholder="Canción, artista o álbum"
        />
      </label>
      {error && (
        <p role="alert" className="error-text">
          {error}
        </p>
      )}
      {adding && (
        <p role="status" className="help">
          Comprobando la duración de «{adding}»…
        </p>
      )}
      <p className="help">
        {matches.length} canciones que caben · Página {currentPage + 1} de{" "}
        {pages}
      </p>
      <ul className="side-library-list">
        {matches
          .slice(currentPage * 30, (currentPage + 1) * 30)
          .map(({ track, source }) => {
            return (
              <li key={track.id}>
                <div>
                  <strong>{track.title}</strong>
                  <small>
                    {track.artist || "Sin artista"}
                    {track.album ? ` · ${track.album}` : ""}
                  </small>
                </div>
                <span>
                  {source?.durationMs
                    ? displayTime(source.durationMs)
                    : "No disponible"}
                </span>
                <button
                  className="icon-button"
                  aria-label={`Añadir ${track.title} a la cara`}
                  disabled={!!adding || !source}
                  onClick={() => {
                    if (adding) return;
                    const controller = new AbortController();
                    abort.current = controller;
                    setAdding(track.title);
                    setError("");
                    void onAdd(track, controller.signal)
                      .catch((e: unknown) => {
                        if (!controller.signal.aborted)
                          setError(
                            e instanceof Error
                              ? e.message
                              : "No se pudo añadir la canción.",
                          );
                      })
                      .finally(() => {
                        if (!controller.signal.aborted) setAdding("");
                      });
                  }}
                >
                  <Plus size={17} />
                </button>
              </li>
            );
          })}
      </ul>
      {!matches.length && (
        <p>
          No hay canciones que quepan con esa búsqueda. Prueba otra búsqueda o
          libera espacio en la cara.
        </p>
      )}
      <div className="modal-actions">
        <button
          className="secondary"
          disabled={currentPage === 0 || !!adding}
          onClick={() => setPage(currentPage - 1)}
        >
          Anterior
        </button>
        <button
          className="secondary"
          disabled={currentPage + 1 >= pages || !!adding}
          onClick={() => setPage(currentPage + 1)}
        >
          Siguiente
        </button>
      </div>
    </Modal>
  );
}
export function CopySidesDialog({
  plan,
  sideId,
  onSave,
  onClose,
}: {
  plan: Plan;
  sideId: string;
  onSave: (next: Plan) => Promise<void>;
  onClose: () => void;
}) {
  const initial = plan.sides.find((s) => s.id === sideId);
  const [name, setName] = useState(
    `${plan.name} · Cinta ${initial?.tape ?? 1}`.slice(0, 160),
  );
  const [a, setA] = useState(
    plan.sides.find((s) => s.tape === initial?.tape && s.face === "A")?.id ??
      "",
  );
  const [b, setB] = useState(
    plan.sides.find((s) => s.tape === initial?.tape && s.face === "B")?.id ??
      "",
  );
  const [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title="Crear cinta independiente"
      onClose={() => {
        if (!saving) onClose();
      }}
    >
      <p className="help">
        Elige las caras que quieres copiar. La nueva cinta se guardará por
        separado y conservará el orden de sus canciones. Puedes dejar una cara
        vacía.
      </p>
      <label>
        Nombre de la nueva cinta
        <input
          autoFocus
          value={name}
          maxLength={160}
          disabled={saving}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <div className="form-grid">
        {(["A", "B"] as const).map((face) => (
          <label key={face}>
            Nueva cara {face}
            <select
              disabled={saving}
              value={face === "A" ? a : b}
              onChange={(e) =>
                face === "A" ? setA(e.target.value) : setB(e.target.value)
              }
            >
              <option value="">Vacía</option>
              {plan.sides.map((side) => (
                <option key={side.id} value={side.id}>
                  Cinta {side.tape} · Cara {side.face} · {side.tracks.length}{" "}
                  canciones
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button className="secondary" disabled={saving} onClick={onClose}>
          Cancelar
        </button>
        <button
          className="primary"
          disabled={saving || !name.trim()}
          onClick={() => {
            setError("");
            try {
              const next = copySidesToTape(
                plan,
                { A: a || undefined, B: b || undefined },
                name,
              );
              setSaving(true);
              void onSave(next)
                .catch((e: unknown) =>
                  setError(
                    e instanceof Error
                      ? e.message
                      : "No se pudo guardar la cinta.",
                  ),
                )
                .finally(() => setSaving(false));
            } catch (e) {
              setError(
                e instanceof Error
                  ? e.message
                  : "Revisa las caras seleccionadas.",
              );
            }
          }}
        >
          <Check size={16} />
          {saving ? "Guardando…" : "Crear y guardar cinta"}
        </button>
      </div>
    </Modal>
  );
}
