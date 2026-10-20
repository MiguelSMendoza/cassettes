import { useRef, useState } from "react";
import { FolderOpen, FileAudio, ArrowUp, X } from "lucide-react";
import { api } from "./api";
import { Modal } from "./Modal";
interface Entry {
  path: string;
  kind: "file" | "folder";
  name?: string;
}
interface Listing {
  path: string;
  parent: string;
  truncated: boolean;
  entries: Entry[];
}
interface Preview {
  id: string;
  entries: Entry[];
}
export function LocalImport({
  disabled,
  onAdded,
}: {
  disabled: boolean;
  onAdded: () => Promise<void>;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [directory, setDirectory] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [manual, setManual] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  async function browse(path?: string) {
    const id = ++requestId.current;
    setBusy(true);
    setError("");
    try {
      const data = await api<Listing>("/files/browse", path ? { path } : {});
      if (id === requestId.current) {
        setListing(data);
        setDirectory(data.path);
      }
    } catch (e) {
      if (id === requestId.current)
        setError(
          e instanceof Error ? e.message : "No se pudo abrir la carpeta.",
        );
    } finally {
      if (id === requestId.current) setBusy(false);
    }
  }
  async function review(selected: string[]) {
    setBusy(true);
    setError("");
    try {
      setPreview(
        await api<Preview>("/files/import/preview", { paths: selected }),
      );
      setListing(null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se pudieron revisar las rutas.",
      );
    } finally {
      setBusy(false);
    }
  }
  function toggle(path: string) {
    setPaths((old) =>
      old.includes(path) ? old.filter((p) => p !== path) : [...old, path],
    );
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      await api("/files/import", { id: preview.id });
      setPreview(null);
      setPaths([]);
      setManual("");
      await onAdded();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "No se pudo añadir la selección.",
      );
    } finally {
      setBusy(false);
    }
  }
  const errorMessage = error ? (
    <p role="alert" className="error-text">
      {error}
    </p>
  ) : null;
  return (
    <section className="local-import">
      <div className="dropzone">
        <div className="empty-icon">
          <FolderOpen size={30} />
        </div>
        <h3>Tu música, donde ya está.</h3>
        <p>
          Añade archivos MP3, WAV o FLAC y carpetas completas.
          <br />
          Se reproducen desde su ubicación original. No se copian ni se mueven.
        </p>
        <button
          className="primary"
          disabled={disabled || busy}
          onClick={() => void browse()}
        >
          <FolderOpen size={17} />
          Elegir archivos o carpetas
        </button>
        <small>Solo guardamos referencias y metadatos en la biblioteca.</small>
      </div>
      <div className="local-paths">
        <label htmlFor="local-paths">
          También puedes pegar rutas completas, una por línea
        </label>
        <textarea
          id="local-paths"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="/Users/tu-usuario/Music/Álbum&#10;/Users/tu-usuario/Audio/canción.mp3"
          rows={3}
        />
        <button
          className="secondary"
          disabled={disabled || busy || !manual.trim()}
          onClick={() =>
            void review(
              manual
                .split("\n")
                .map((p) => p.trim())
                .filter(Boolean),
            )
          }
        >
          Revisar ubicaciones
        </button>
      </div>
      {!listing && !preview && errorMessage}
      {listing && (
        <Modal
          title="Elegir archivos o carpetas"
          onClose={() => {
            if (!busy) {
              requestId.current++;
              setListing(null);
            }
          }}
        >
          <p className="help">
            Explora este ordenador y marca lo que quieras añadir. Abrir una
            carpeta no la incorpora.
          </p>
          <form
            className="input-action"
            onSubmit={(e) => {
              e.preventDefault();
              void browse(directory);
            }}
          >
            <label className="browser-path">
              Carpeta
              <input
                value={directory}
                onChange={(e) => setDirectory(e.target.value)}
              />
            </label>
            <button className="secondary" disabled={busy} type="submit">
              Abrir ruta
            </button>
          </form>
          <div className="browser-toolbar">
            <button
              className="text-button"
              disabled={busy || listing.parent === listing.path}
              onClick={() => void browse(listing.parent)}
            >
              <ArrowUp size={16} />
              Subir
            </button>
            <button
              className="secondary"
              disabled={busy || paths.includes(listing.path)}
              onClick={() => toggle(listing.path)}
            >
              Seleccionar esta carpeta
            </button>
          </div>
          <ul className="file-browser" aria-label="Archivos y carpetas">
            {listing.entries.map((e) => (
              <li key={e.path}>
                <input
                  type="checkbox"
                  aria-label={`Seleccionar ${e.name}`}
                  checked={paths.includes(e.path)}
                  disabled={busy}
                  onChange={() => toggle(e.path)}
                />
                {e.kind === "folder" ? (
                  <FolderOpen size={19} />
                ) : (
                  <FileAudio size={19} />
                )}
                {e.kind === "folder" ? (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() => void browse(e.path)}
                    aria-label={`Abrir carpeta ${e.name}`}
                  >
                    {e.name}
                  </button>
                ) : (
                  <span>{e.name}</span>
                )}
              </li>
            ))}
          </ul>
          {!listing.entries.length && (
            <p>No hay audio ni subcarpetas visibles en esta ubicación.</p>
          )}
          {listing.truncated && (
            <p className="help">
              Mostrando las primeras 2.000 entradas. Puedes pegar una ruta
              concreta o seleccionar esta carpeta completa.
            </p>
          )}
          <p className="help">{paths.length} ubicaciones seleccionadas</p>
          {paths.length > 0 && (
            <ul className="selected-paths">
              {paths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                  <button
                    className="icon-button"
                    aria-label={`Quitar ${p} de la selección`}
                    onClick={() => toggle(p)}
                    disabled={busy}
                  >
                    <X size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {errorMessage}
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setListing(null)}
            >
              Cancelar
            </button>
            <button
              className="primary"
              disabled={busy || !paths.length}
              onClick={() => void review(paths)}
            >
              {busy ? "Leyendo…" : "Revisar selección"}
            </button>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal
          title="Añadir a la biblioteca sin copiar"
          onClose={() => {
            if (!busy) setPreview(null);
          }}
        >
          <p>
            Guardaremos estas ubicaciones originales. Las carpetas se analizarán
            con sus subcarpetas; los archivos sueltos se añadirán
            individualmente.
          </p>
          <ul className="selected-paths">
            {preview.entries.map((e) => (
              <li key={e.path}>
                <strong>{e.kind === "folder" ? "Carpeta" : "Archivo"}</strong>
                <code>{e.path}</code>
              </li>
            ))}
          </ul>
          <p className="help">
            No se crearán copias de audio. Si desconectas el disco o eliminas un
            archivo, su referencia quedará no disponible.
          </p>
          {errorMessage}
          <div className="modal-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setPreview(null)}
            >
              Cancelar
            </button>
            <button
              className="primary"
              disabled={busy || disabled}
              onClick={() => void confirm()}
            >
              {busy ? "Añadiendo…" : "Añadir sin copiar"}
            </button>
          </div>
        </Modal>
      )}
    </section>
  );
}
