import { createReadStream, constants } from "node:fs";
import {
  access,
  realpath,
  lstat,
  readdir,
  mkdir,
  link,
  unlink,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { parseFile } from "music-metadata";
import chokidar, { type FSWatcher } from "chokidar";
import { Catalog, uid, type LocationRow, type SourceRow } from "./db";
import type { Operation, Root } from "../domain/types";
export class UserError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}
export async function hashFile(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}
export function safeName(name: string) {
  const clean = name
    .normalize("NFC")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 200);
  if (
    !clean ||
    clean === "." ||
    clean === ".." ||
    /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i.test(clean)
  )
    throw new UserError("Nombre de archivo no válido.");
  return clean;
}
export async function confined(
  root: string,
  relative: string,
  allowMissing = false,
) {
  if (
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).some((s) => s === ".." || s === "")
  )
    throw new UserError("Ruta fuera de la carpeta de música.");
  if ((await lstat(root)).isSymbolicLink())
    throw new UserError("No se permiten enlaces simbólicos.");
  const canonical = await realpath(root);
  let current = canonical;
  const parts = relative.split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink())
        throw new UserError("No se permiten enlaces simbólicos.");
      if (i < parts.length - 1 && !info.isDirectory())
        throw new UserError("Ruta no válida.");
    } catch (e) {
      if (
        allowMissing &&
        i === parts.length - 1 &&
        (e as NodeJS.ErrnoException).code === "ENOENT"
      )
        return current;
      throw e;
    }
  }
  return current;
}
export class Library {
  scanState = {
    running: false,
    processed: 0,
    errors: [] as string[],
    lastRun: null as string | null,
  };
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cancelled = false;
  lockedSources = new Set<string>();
  mutating = false;
  constructor(readonly catalog: Catalog) {}
  async rootStatus(): Promise<Root> {
    const r = this.catalog.root();
    let connected = true,
      writable = true;
    try {
      await access(r.path, constants.R_OK);
    } catch {
      connected = false;
    }
    try {
      await access(r.path, constants.W_OK);
    } catch {
      writable = false;
    }
    return { ...r, connected, writable };
  }
  async chooseRoot(input: string) {
    if (this.mutating || this.scanState.running)
      throw new UserError("Espera a que termine la operación actual.");
    if (this.lockedSources.size)
      throw new UserError("Detén la reproducción antes de cambiar de carpeta.");
    const canonical = await realpath(path.resolve(input));
    if (
      canonical === path.parse(canonical).root ||
      canonical === process.env.HOME
    )
      throw new UserError(
        "Elige una carpeta de música concreta, no todo el disco o tu carpeta personal.",
      );
    if (!(await stat(canonical)).isDirectory())
      throw new UserError("La ruta no es una carpeta.");
    this.catalog.setRoot(canonical);
    await this.watch();
    void this.scan();
    return this.rootStatus();
  }
  async watch() {
    await this.watcher?.close();
    if (this.timer) clearTimeout(this.timer);
    this.watcher = chokidar.watch(
      this.catalog.entries().map((e) => e.path),
      {
        ignoreInitial: true,
        followSymlinks: false,
        depth: 30,
        ignored: (p) => path.basename(p).startsWith("."),
        awaitWriteFinish: { stabilityThreshold: 1500, pollInterval: 300 },
      },
    );
    this.watcher.on("all", () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        void this.scan();
      }, 1000);
    });
    this.watcher.on("error", () => {
      this.scanState.errors = [
        "No se pudo vigilar la carpeta. Puedes actualizarla manualmente.",
      ];
    });
  }
  cancel() {
    this.cancelled = true;
  }
  async scan(full = false) {
    if (this.scanState.running || this.mutating) return;
    this.cancelled = false;
    this.scanState = {
      running: true,
      processed: 0,
      errors: [],
      lastRun: this.scanState.lastRun,
    };
    const roots = new Map(this.catalog.roots().map((r) => [r.id, r]));
    const known = new Map(
      this.catalog
        .locations()
        .map((l) => [
          path.join(roots.get(l.root_id)!.path, l.relative_path),
          l,
        ]),
    );
    const seen = new Set<string>();
    const checked = new Set<string>();
    const inspect = async (file: string, rootId: string) => {
      if (this.cancelled || seen.has(file)) return;
      seen.add(file);
      const root = roots.get(rootId)!;
      try {
        await confined(root.path, path.relative(root.path, file));
        const info = await stat(file);
        const old = known.get(file);
        if (
          !full &&
          old &&
          !old.trashed &&
          old.size === info.size &&
          Math.abs(old.mtime - info.mtimeMs) < 1
        ) {
          this.catalog.db
            .prepare("UPDATE locations SET available=1 WHERE id=?")
            .run(old.id);
        } else
          await this.indexFile(
            file,
            old?.root_id ?? rootId,
            old?.relative_path ?? path.relative(root.path, file),
          );
        this.scanState.processed++;
      } catch (e) {
        const old = known.get(file);
        if (old && !old.trashed)
          this.catalog.db
            .prepare("UPDATE locations SET available=0 WHERE id=?")
            .run(old.id);
        this.scanState.errors.push(
          `${path.basename(file)}: ${e instanceof Error ? e.message : "No se pudo analizar"}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const walk = async (
      dir: string,
      rootId: string,
      depth = 0,
    ): Promise<void> => {
      if (depth > 30 || this.cancelled || checked.has(dir)) return;
      let entries;
      try {
        if ((await lstat(dir)).isSymbolicLink())
          throw new UserError("No se permiten enlaces simbólicos.");
        entries = await readdir(dir, { withFileTypes: true });
        checked.add(dir);
      } catch {
        this.scanState.errors.push(
          `Carpeta desconectada o sin permisos: ${dir}`,
        );
        for (const [file, loc] of known)
          if (!loc.trashed && file.startsWith(dir + path.sep))
            this.catalog.db
              .prepare("UPDATE locations SET available=0 WHERE id=?")
              .run(loc.id);
        return;
      }
      for (const entry of entries) {
        if (this.cancelled) break;
        if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file, rootId, depth + 1);
        else if (entry.isFile() && /\.(mp3|wav|flac)$/i.test(entry.name))
          await inspect(file, rootId);
      }
    };
    try {
      for (const entry of this.catalog.entries()) {
        if (this.cancelled) break;
        if (entry.kind === "folder") await walk(entry.path, entry.rootId);
        else if (
          !entry.relativePath.split(path.sep).some((p) => p.startsWith("."))
        )
          await inspect(entry.path, entry.rootId);
      }
      if (!this.cancelled)
        // Solo reconciliar la instantánea inicial: descargas nuevas pueden
        // haberse publicado después de leer los directorios.
        for (const loc of known.values()) {
          const file = path.join(
            roots.get(loc.root_id)!.path,
            loc.relative_path,
          );
          if (
            !loc.trashed &&
            checked.has(path.dirname(file)) &&
            !seen.has(file)
          )
            this.catalog.db
              .prepare("UPDATE locations SET available=0 WHERE id=?")
              .run(loc.id);
        }
      this.scanState.lastRun = new Date().toISOString();
    } finally {
      this.scanState.running = false;
    }
  }
  async validatePaths(paths: string[]) {
    const entries: { path: string; kind: "file" | "folder" }[] = [];
    for (const input of paths) {
      if (!path.isAbsolute(input))
        throw new UserError("Introduce una ruta absoluta del ordenador.");
      // Comprobar cada componente antes de resolver: no ampliar permisos a través de symlinks.
      await confined(
        path.parse(input).root,
        path.relative(path.parse(input).root, input),
      );
      const canonical = await realpath(input);
      const info = await stat(canonical);
      if (info.isDirectory()) {
        if (
          canonical === path.parse(canonical).root ||
          canonical === process.env.HOME
        )
          throw new UserError(
            "Elige una carpeta de música concreta, no todo el disco o tu carpeta personal.",
          );
      } else if (!info.isFile() || !/\.(mp3|wav|flac)$/i.test(canonical))
        throw new UserError("Selecciona archivos MP3, WAV o FLAC, o carpetas.");
      await access(canonical, constants.R_OK);
      if (!entries.some((e) => e.path === canonical))
        entries.push({
          path: canonical,
          kind: info.isDirectory() ? "folder" : "file",
        });
    }
    return entries;
  }
  async addPaths(paths: string[], watch = true) {
    if (this.mutating || this.scanState.running || this.lockedSources.size)
      throw new UserError(
        "Espera a que terminen el escaneo y la reproducción.",
      );
    const entries = await this.validatePaths(paths);
    if (this.mutating || this.scanState.running || this.lockedSources.size)
      throw new UserError(
        "Espera a que terminen el escaneo y la reproducción.",
      );
    this.catalog.db.transaction(() => {
      for (const e of entries) {
        const root = this.catalog.ensureRoot(
          e.kind === "folder" ? e.path : path.dirname(e.path),
        );
        this.catalog.includePath(
          root.id,
          e.kind === "folder" ? "" : path.basename(e.path),
        );
      }
    })();
    if (watch) await this.watch();
    return entries;
  }
  async indexFile(
    file: string,
    rootId: string,
    relativePath: string,
    knownTrack?: string,
  ) {
    const before = await stat(file);
    if (before.size > 1024 * 1024 * 1024)
      throw new UserError("El archivo supera el límite de 1 GB.");
    const metadata = await parseFile(file, {
      duration: true,
      skipCovers: true,
    });
    if (!metadata.format.duration || !metadata.format.codec)
      throw new UserError("Audio corrupto o duración desconocida.");
    const hash = await hashFile(file);
    const after = await stat(file);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new UserError("El archivo está cambiando. Se volverá a intentar.");
    let source = this.catalog.db
      .prepare("SELECT * FROM sources WHERE kind='local' AND key=?")
      .get(hash) as SourceRow | undefined;
    const transaction = this.catalog.db.transaction(() => {
      if (!source) {
        const trackId = knownTrack ?? uid();
        if (!knownTrack)
          this.catalog.db
            .prepare(
              "INSERT INTO tracks(id,title,artist,album,genres,disc,track_number) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              trackId,
              metadata.common.title?.trim() || path.basename(file),
              metadata.common.artist ?? "",
              metadata.common.album ?? "",
              JSON.stringify(metadata.common.genre ?? []),
              metadata.common.disk.no,
              metadata.common.track.no,
            );
        const id = uid();
        this.catalog.db
          .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)")
          .run(
            id,
            trackId,
            "local",
            hash,
            Math.ceil(metadata.format.duration! * 1000),
            hash,
            JSON.stringify({
              bitrate: metadata.format.bitrate,
              codec: metadata.format.codec,
              sampleRate: metadata.format.sampleRate,
            }),
            Date.now(),
            null,
          );
        source = this.catalog.source(id)!;
      }
      const old = this.catalog.db
        .prepare("SELECT * FROM locations WHERE root_id=? AND relative_path=?")
        .get(rootId, relativePath) as LocationRow | undefined;
      this.catalog.db
        .prepare(
          "INSERT INTO locations VALUES(?,?,?,?,?,?,1,0,NULL) ON CONFLICT(root_id,relative_path) DO UPDATE SET source_id=excluded.source_id,size=excluded.size,mtime=excluded.mtime,available=1,trashed=0,original_path=NULL",
        )
        .run(
          old?.id ?? uid(),
          source!.id,
          rootId,
          relativePath,
          after.size,
          after.mtimeMs,
        );
    });
    transaction();
    return source!.id;
  }
  async sourceFile(sourceId: string, expectedRevision?: string) {
    const source = this.catalog.source(sourceId);
    if (!source) throw new UserError("Archivo no disponible.", 404);
    if (
      source.kind !== "local" ||
      (expectedRevision && source.revision !== expectedRevision)
    )
      throw new UserError(
        "La fuente ha cambiado. Genera una nueva revisión del plan.",
      );
    const roots = new Map(this.catalog.roots().map((r) => [r.id, r]));
    for (const loc of this.catalog
      .locations()
      .filter((l) => l.source_id === sourceId && l.available && !l.trashed)) {
      try {
        const file = await confined(
          roots.get(loc.root_id)!.path,
          loc.relative_path,
        );
        const info = await stat(file);
        if (info.size !== loc.size || Math.abs(info.mtimeMs - loc.mtime) > 1)
          throw new UserError("Archivo modificado");
        return { file, loc, source };
      } catch {
        this.catalog.db
          .prepare("UPDATE locations SET available=0 WHERE id=?")
          .run(loc.id);
      }
    }
    throw new UserError(
      "Archivo no disponible o modificado. Actualiza la biblioteca y comprueba la ubicación original.",
      404,
    );
  }
  async preview(
    locationId: string,
    action: "rename" | "trash" | "restore",
    name?: string,
  ) {
    const loc = this.catalog.location(locationId);
    const root = this.catalog.roots().find((r) => r.id === loc?.root_id);
    if (!loc || !root) throw new UserError("Ubicación no disponible.");
    if (this.lockedSources.has(loc.source_id))
      throw new UserError(
        "Este archivo está en una sesión activa. Detén la reproducción primero.",
      );
    if (
      (action === "restore" && !loc.trashed) ||
      (action !== "restore" && loc.trashed)
    )
      throw new UserError("La acción no coincide con el estado del archivo.");
    const source = this.catalog.source(loc.source_id)!;
    const oldPath = await confined(root.path, loc.relative_path);
    if ((await hashFile(oldPath)) !== source.key)
      throw new UserError(
        "El contenido cambió; vuelve a escanear antes de modificarlo.",
      );
    let to: string;
    if (action === "rename") {
      if (!name) throw new UserError("Escribe el nuevo nombre.");
      const clean = safeName(name);
      if (
        path.extname(clean).toLowerCase() !==
        path.extname(loc.relative_path).toLowerCase()
      )
        throw new UserError("Renombrar debe conservar la extensión del audio.");
      to = path.join(path.dirname(loc.relative_path), clean);
    } else if (action === "trash") {
      await mkdir(path.join(root.path, ".cassettes-trash"), {
        recursive: true,
      });
      await confined(root.path, ".cassettes-trash");
      to = path.join(
        ".cassettes-trash",
        `${uid()}-${path.basename(loc.relative_path)}`,
      );
    } else to = loc.original_path ?? "";
    if (to === loc.relative_path)
      throw new UserError("El nombre no ha cambiado.");
    const destination = await confined(root.path, to, true);
    const siblings = await readdir(path.dirname(destination));
    if (
      siblings.some(
        (n) =>
          n.normalize("NFC").toLowerCase() ===
          path.basename(to).normalize("NFC").toLowerCase(),
      )
    )
      throw new UserError(
        "Ya existe un archivo con ese nombre. No se sobrescribirá.",
      );
    const op: Operation = {
      id: uid(),
      action,
      locationId,
      from: loc.relative_path,
      to,
      status: "planned",
      error: null,
      hash: source.key,
    };
    this.catalog.saveOperation(op);
    return op;
  }
  async apply(id: string) {
    if (this.mutating || this.scanState.running)
      throw new UserError(
        "Espera a que termine la operación o el escaneo actual.",
      );
    this.mutating = true;
    try {
      return await this.performApply(id);
    } finally {
      this.mutating = false;
    }
  }
  private async performApply(id: string) {
    const op = this.catalog.operations().find((o) => o.id === id);
    if (!op) throw new UserError("Operación desconocida.");
    if (op.status === "committed") return op;
    if (op.status !== "planned")
      throw new UserError("La operación requiere revisión.");
    const loc = this.catalog.location(op.locationId);
    if (
      !loc ||
      this.lockedSources.has(loc.source_id) ||
      loc.relative_path !== op.from
    )
      throw new UserError(
        "El archivo cambió o está en uso. Genera otra vista previa.",
      );
    const root = this.catalog.roots().find((r) => r.id === loc.root_id)!;
    const from = await confined(root.path, op.from);
    const to = await confined(root.path, op.to, true);
    if ((await hashFile(from)) !== op.hash)
      throw new UserError("El contenido ha cambiado desde la vista previa.");
    if (this.lockedSources.has(loc.source_id))
      throw new UserError("El archivo acaba de entrar en una sesión.");
    op.status = "applying";
    this.catalog.saveOperation(op);
    try {
      await link(from, to);
      op.status = "filesystemApplied";
      this.catalog.saveOperation(op);
      await unlink(from);
      this.commitOperation(op);
      return op;
    } catch (e) {
      op.status = "needsRecovery";
      op.error = e instanceof Error ? e.message : "No se pudo completar";
      this.catalog.saveOperation(op);
      throw new UserError(
        "Operación interrumpida. Revisa el historial; no se sobrescribió el destino.",
      );
    }
  }
  private commitOperation(op: Operation) {
    const loc = this.catalog.location(op.locationId)!;
    this.catalog.db.transaction(() => {
      this.catalog.db
        .prepare(
          "UPDATE locations SET relative_path=?,trashed=?,original_path=?,available=? WHERE id=?",
        )
        .run(
          op.to,
          op.action === "trash" ? 1 : 0,
          op.action === "trash" ? op.from : null,
          op.action === "trash" ? 0 : 1,
          loc.id,
        );
      if (
        this.catalog
          .entries()
          .some((e) => e.rootId === loc.root_id && e.relativePath === op.from)
      ) {
        this.catalog.includePath(loc.root_id, op.to);
        this.catalog.db
          .prepare(
            "DELETE FROM library_entries WHERE root_id=? AND relative_path=?",
          )
          .run(loc.root_id, op.from);
      }
      op.status = "committed";
      op.error = null;
      this.catalog.saveOperation(op);
    })();
  }
  async recover() {
    for (const op of this.catalog
      .operations()
      .filter((o) =>
        ["applying", "filesystemApplied", "needsRecovery"].includes(o.status),
      )) {
      try {
        const loc = this.catalog.location(op.locationId);
        if (!loc) continue;
        const root = this.catalog.roots().find((r) => r.id === loc.root_id);
        if (!root) continue;
        const to = await confined(root.path, op.to);
        if ((await hashFile(to)) !== op.hash) continue;
        let sourceExists = true;
        try {
          await confined(root.path, op.from);
        } catch {
          sourceExists = false;
        }
        if (!sourceExists) this.commitOperation(op);
        else {
          op.status = "needsRecovery";
          op.error =
            "Existen origen y destino. Se conservan ambos; revisa las copias antes de continuar.";
          this.catalog.saveOperation(op);
        }
      } catch {
        /* Mantener el diario para revisión manual sin borrar archivos. */
      }
    }
  }
  async verifySource(id: string, revision: string) {
    const { file, source } = await this.sourceFile(id, revision);
    if ((await hashFile(file)) !== source.key)
      throw new UserError(
        "El contenido cambió. Actualiza la biblioteca y el plan.",
      );
  }
  async close() {
    if (this.timer) clearTimeout(this.timer);
    await this.watcher?.close();
  }
}
