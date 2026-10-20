import Fastify from "fastify";
import staticPlugin from "@fastify/static";
import {
  mkdir,
  realpath,
  lstat,
  stat,
  access,
  copyFile,
  readdir,
} from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z, ZodError } from "zod";
import { Catalog, uid, type SourceRow } from "./db";
import { Library, UserError, confined, hashFile } from "./files";
import { YouTube } from "./youtube";
import { Downloads } from "./downloads";
import { Playlists } from "./playlists";
import { compatibleWav } from "./audio";
import { restoreSchema, restoreCatalog, type RestoreData } from "./restore";
import { ffmpeg, hasDownloader } from "./tools";
import { planSchema, occurrenceSchema } from "../domain/schemas";
import { sideTiming, validateConfig } from "../domain/planner";
import type { Snapshot, Plan, Playlist } from "../domain/types";
export async function createApp(
  options: { dataDir?: string; port?: number; watch?: boolean } = {},
) {
  const dataDir = path.resolve(
    options.dataDir ?? process.env.CASSETTES_DATA_DIR ?? ".data",
  );
  const port = options.port ?? Number(process.env.PORT ?? 4310);
  await mkdir(path.join(dataDir, "music"), { recursive: true });
  const catalog = new Catalog(dataDir);
  if (!catalog.getSetting("root"))
    catalog.setRoot(await realpath(path.join(dataDir, "music")));
  const library = new Library(catalog),
    youtube = new YouTube(catalog, port),
    downloads = new Downloads(catalog, library);
  const app = Fastify({
    logger: false,
    bodyLimit: 20 * 1024 * 1024,
    requestTimeout: 180000,
  });
  const playlists = new Playlists(catalog);
  const audioConversions = new Set<AbortController>();
  const rootDrafts = new Map<string, string>();
  const playlistDrafts = new Map<string, Playlist>();
  let session: { id: string; sourceIds: string[]; expires: number } | null =
    null;
  const release = () => {
    session = null;
    library.lockedSources.clear();
  };
  app.addHook("onRequest", async (req, reply) => {
    let host: URL;
    try {
      host = new URL(`http://${req.headers.host ?? ""}`);
    } catch {
      return reply.code(403).send({ error: "Host no permitido." });
    }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(host.hostname))
      return reply.code(403).send({ error: "Solo se admite acceso local." });
    const origin = req.headers.origin;
    if (
      origin &&
      !new Set([
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ]).has(origin)
    )
      return reply.code(403).send({ error: "Origen no permitido." });
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-cassettes-client"] !== "local"
    )
      return reply
        .code(403)
        .send({ error: "La acción requiere el cliente local." });
    if (session && session.expires < Date.now()) release();
  });
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError)
      return reply.code(400).send({
        error: "Hay datos no válidos. Revisa los campos.",
        details: error.issues.map((i) => i.message),
      });
    const e = error instanceof Error ? error : new Error("Error inesperado.");
    return reply
      .code(error instanceof UserError ? error.statusCode : 400)
      .send({ error: e.message });
  });
  const snapshot = async (): Promise<Snapshot> => {
    catalog.expire();
    return {
      tracks: catalog.tracks(true),
      roots: await Promise.all(
        catalog.roots().map(async (r) => {
          let connected = true,
            writable = true;
          try {
            await access(r.path);
          } catch {
            connected = false;
          }
          try {
            await access(r.path, 2);
          } catch {
            writable = false;
          }
          return { ...r, connected, writable };
        }),
      ),
      root: await library.rootStatus(),
      libraryPaths: catalog.entries().map(({ path, kind }) => ({ path, kind })),
      plans: catalog.plans(),
      playlists: catalog.playlists(),
      jobs: catalog.jobs(),
      operations: catalog.operations().slice(0, 200),
      scan: library.scanState,
      google: { configured: youtube.configured, connected: youtube.connected },
      audio: { downloader: hasDownloader(), ffmpeg: existsSync(ffmpeg) },
      session: session
        ? { id: session.id, sourceIds: session.sourceIds }
        : null,
    };
  };
  app.get("/api/state", async () => {
    downloads.syncPlaylists();
    return snapshot();
  });
  app.get("/api/health", () => ({ ok: true }));
  app.post("/api/root/preview", async (req) => {
    if (catalog.jobs().some((j) => ["queued", "running"].includes(j.status)))
      throw new UserError(
        "Espera a que terminen las descargas antes de cambiar de carpeta.",
      );
    const input = z
      .object({ path: z.string().min(1).max(4000) })
      .parse(req.body);
    const canonical = await realpath(path.resolve(input.path));
    if (
      !(await stat(canonical)).isDirectory() ||
      canonical === path.parse(canonical).root ||
      canonical === process.env.HOME
    )
      throw new UserError("Selecciona una carpeta de música concreta.");
    const id = uid();
    rootDrafts.set(id, canonical);
    return { id, path: canonical };
  });
  app.post("/api/root/confirm", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    const directory = rootDrafts.get(id);
    if (!directory) throw new UserError("Vuelve a elegir la carpeta.");
    if (catalog.jobs().some((j) => ["queued", "running"].includes(j.status)))
      throw new UserError("Hay descargas pendientes.");
    rootDrafts.delete(id);
    await library.chooseRoot(directory);
    return { ok: true };
  });
  app.post("/api/scan", async (req) => {
    const { full } = z
      .object({ full: z.boolean().default(false) })
      .parse(req.body ?? {});
    void library.scan(full);
    return { ok: true };
  });
  app.post("/api/scan/cancel", () => {
    library.cancel();
    return { ok: true };
  });
  // El navegador no expone rutas originales en input[type=file]. Navegamos el
  // disco a través del servidor local y transmitimos únicamente rutas, nunca audio.
  app.post("/api/files/browse", async (req) => {
    const input = z
      .object({ path: z.string().max(4000).optional() })
      .parse(req.body ?? {});
    const directory = await realpath(input.path || os.homedir());
    if (!(await stat(directory)).isDirectory())
      throw new UserError("Selecciona una carpeta.");
    const entries = (await readdir(directory, { withFileTypes: true }))
      .filter(
        (e) =>
          !e.name.startsWith(".") &&
          !e.isSymbolicLink() &&
          (e.isDirectory() ||
            (e.isFile() && /\.(mp3|wav|flac)$/i.test(e.name))),
      )
      .sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          a.name.localeCompare(b.name, "es"),
      );
    return {
      path: directory,
      parent: path.dirname(directory),
      truncated: entries.length > 2000,
      entries: entries.slice(0, 2000).map((e) => ({
        name: e.name,
        path: path.join(directory, e.name),
        kind: e.isDirectory() ? "folder" : "file",
      })),
    };
  });
  const importDrafts = new Map<
    string,
    { path: string; kind: "file" | "folder" }[]
  >();
  app.post("/api/files/import/preview", async (req) => {
    const { paths } = z
      .object({ paths: z.array(z.string().min(1).max(4000)).min(1).max(500) })
      .parse(req.body);
    const entries = await library.validatePaths(paths);
    const id = uid();
    if (importDrafts.size >= 50)
      importDrafts.delete(importDrafts.keys().next().value!);
    importDrafts.set(id, entries);
    return { id, entries };
  });
  app.post("/api/files/import", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    const entries = importDrafts.get(id);
    if (!entries)
      throw new UserError("Vuelve a seleccionar los archivos y carpetas.");
    const added = await library.addPaths(
      entries.map((e) => e.path),
      options.watch !== false,
    );
    importDrafts.delete(id);
    void library.scan();
    return { entries: added };
  });
  app.post("/api/files/preview", async (req) => {
    const p = z
      .object({
        locationId: z.string(),
        action: z.enum(["rename", "trash", "restore"]),
        name: z.string().max(240).optional(),
      })
      .parse(req.body);
    return library.preview(p.locationId, p.action, p.name);
  });
  app.post("/api/files/apply", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    return library.apply(id);
  });
  app.post("/api/tracks/edit", async (req) => {
    const p = z
      .object({
        id: z.string(),
        title: z
          .string()
          .trim()
          .min(1, "Escribe un título para la canción.")
          .max(1000),
        artist: z.string().max(1000),
        album: z.string().max(1000),
        genres: z.array(z.string().max(100)).max(30),
      })
      .parse(req.body);
    const { id, ...changes } = p;
    if (!catalog.editTrack(id, changes))
      throw new UserError("La canción ya no está en la biblioteca.", 404);
    return { ok: true };
  });
  app.post("/api/tracks/visibility", async (req) => {
    const { ids, hidden } = z
      .object({ ids: z.array(z.string()).max(10000), hidden: z.boolean() })
      .parse(req.body);
    catalog.db.transaction(() => {
      for (const id of ids)
        catalog.db
          .prepare("UPDATE tracks SET hidden=? WHERE id=?")
          .run(hidden ? 1 : 0, id);
    })();
    return { ok: true };
  });
  app.post("/api/youtube/import", async (req) => {
    const { urls } = z
      .object({ urls: z.array(z.string().max(2000)).min(1).max(100) })
      .parse(req.body);
    return { jobs: await downloads.enqueue(urls) };
  });
  const trackIdsSchema = z.array(z.string().min(1).max(200)).max(20000);
  app.post("/api/playlists/create", async (req) => {
    const p = z
      .object({
        name: z.string().trim().min(1).max(200),
        trackIds: trackIdsSchema.default([]),
      })
      .parse(req.body);
    return playlists.create(p.name, p.trackIds);
  });
  app.post("/api/playlists/add", async (req) => {
    const p = z
      .object({ id: z.string(), trackIds: trackIdsSchema.min(1) })
      .parse(req.body);
    return playlists.add(p.id, p.trackIds);
  });
  app.post("/api/playlists/rename", async (req) => {
    const p = z
      .object({ id: z.string(), name: z.string().trim().min(1).max(200) })
      .parse(req.body);
    return playlists.rename(p.id, p.name);
  });
  app.post("/api/playlists/delete", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    playlists.delete(id);
    return { ok: true };
  });
  app.post("/api/playlists/download", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    const p = catalog.playlists().find((p) => p.id === id);
    if (!p) throw new UserError("La playlist ya no existe.");
    return downloads.playlist(p);
  });
  app.post("/api/playlists/remove", async (req) => {
    const p = z.object({ id: z.string(), itemId: z.string() }).parse(req.body);
    return playlists.remove(p.id, p.itemId);
  });
  app.post("/api/playlists/preview", async (req) => {
    const p = z
      .object({
        url: z.string().max(2000),
        private: z.boolean().default(false),
      })
      .parse(req.body);
    const playlist = await youtube.previewPlaylist(p.url, p.private);
    playlistDrafts.set(playlist.id, playlist);
    return playlist;
  });
  app.post("/api/playlists/confirm", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    const p = playlistDrafts.get(id);
    if (!p) throw new UserError("Vuelve a previsualizar la lista.");
    const committed = await youtube.downloadPlaylist(id, downloads);
    playlistDrafts.delete(id);
    return committed;
  });
  app.post("/api/downloads", async (req) => {
    if (library.mutating)
      throw new UserError("Espera a que termine la operación de archivos.");
    const { urls } = z
      .object({ urls: z.array(z.string().max(2000)).min(1).max(200) })
      .parse(req.body);
    return { jobs: await downloads.enqueue(urls) };
  });
  app.post("/api/downloads/cancel", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    downloads.cancel(id);
    return { ok: true };
  });
  app.post("/api/google/connect", () => ({ url: youtube.authUrl() }));
  app.get("/api/google/callback", async (req, reply) => {
    const p = z
      .object({ code: z.string(), state: z.string() })
      .parse(req.query);
    await youtube.callback(p.code, p.state);
    return reply
      .type("text/html")
      .send(
        '<!doctype html><html lang="es"><meta charset="utf-8"><title>Cuenta conectada</title><body><h1>Cuenta conectada</h1><p>Vuelve a Cassettes. La sesión se conserva solo mientras el servidor esté abierto.</p><a href="/">Volver a Cassettes</a></body></html>',
      );
  });
  app.post("/api/google/disconnect", async () => {
    await youtube.disconnect();
    playlistDrafts.clear();
    return { ok: true };
  });
  function validatePlan(p: Plan) {
    validateConfig(p.config);
    const occurrences = p.sides.flatMap((s) => s.tracks);
    if (new Set(occurrences.map((t) => t.id)).size !== occurrences.length)
      throw new UserError("Plan con ocurrencias duplicadas.");
    for (const side of p.sides) {
      const actual = sideTiming(side.tracks, p.config);
      if (
        actual.freeMs < 0 ||
        actual.programMs !== side.programMs ||
        actual.occupiedMs !== side.occupiedMs
      )
        throw new UserError("La duración del plan no es válida.");
    }
    for (const t of occurrences) {
      const source = catalog.source(t.sourceId);
      if (
        !source ||
        source.revision !== t.revision ||
        source.duration_ms !== t.durationMs ||
        source.track_id !== t.trackId ||
        source.kind !== t.kind
      )
        throw new UserError("Una fuente cambió. Genera un nuevo plan.");
    }
  }
  app.post("/api/sources/duration", async (req) => {
    const p = z
      .object({
        sourceId: z.string(),
        durationMs: z.number().int().positive().max(86400000),
        revision: z.string(),
      })
      .parse(req.body);
    const source = catalog.source(p.sourceId);
    if (!source || source.kind !== "local" || source.revision !== p.revision)
      throw new UserError("La fuente cambió. Actualiza la biblioteca.");
    if (library.lockedSources.has(source.id))
      throw new UserError("No se puede cambiar una fuente en uso.");
    if (
      source.duration_ms !== null &&
      Math.abs(source.duration_ms - p.durationMs) > 10000
    )
      throw new UserError(
        "La duración decodificada difiere demasiado. Revisa el archivo.",
      );
    const revision = `${source.key}:${p.durationMs}`;
    catalog.db
      .prepare("UPDATE sources SET duration_ms=?,revision=? WHERE id=?")
      .run(p.durationMs, revision, p.sourceId);
    return { revision };
  });
  app.post("/api/plans", async (req) => {
    const p = planSchema.parse(req.body);
    validatePlan(p);
    catalog.savePlan(p);
    return p;
  });
  app.post("/api/plans/delete", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    if (session) throw new UserError("Detén la sesión primero.");
    catalog.db.prepare("DELETE FROM plans WHERE id=?").run(id);
    return { ok: true };
  });
  app.post("/api/session/start", async (req) => {
    if (library.mutating)
      throw new UserError("Espera a que termine la operación de archivos.");
    if (session || library.lockedSources.size)
      throw new UserError(
        "Ya hay una sesión activa. Detén o espera a que caduque.",
      );
    const { tracks } = z
      .object({ tracks: z.array(occurrenceSchema).min(1).max(500) })
      .parse(req.body);
    const sourceIds = [...new Set(tracks.map((t) => t.sourceId))];
    library.lockedSources = new Set(sourceIds);
    try {
      for (const t of tracks) {
        const s = catalog.source(t.sourceId);
        if (t.kind !== "local" || s?.kind !== "local")
          throw new UserError(
            "Descarga primero el MP3. Esta aplicación solo reproduce archivos locales.",
          );
        if (
          !s ||
          s.revision !== t.revision ||
          s.duration_ms !== t.durationMs ||
          s.track_id !== t.trackId
        )
          throw new UserError("La fuente del plan cambió.");
        if (t.kind === "local")
          await library.verifySource(t.sourceId, t.revision);
      }
      session = { id: uid(), sourceIds, expires: Date.now() + 45000 };
      return { id: session.id };
    } catch (e) {
      release();
      throw e;
    }
  });
  app.post("/api/session/heartbeat", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    if (!session || session.id !== id)
      throw new UserError("La sesión ya no está activa.");
    try {
      for (const sourceId of session.sourceIds) {
        const s = catalog.source(sourceId);
        if (s?.kind === "local") await library.sourceFile(sourceId, s.revision);
      }
      session.expires = Date.now() + 45000;
      return { ok: true };
    } catch (e) {
      release();
      throw e;
    }
  });
  app.post("/api/session/stop", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    if (session?.id === id) release();
    return { ok: true };
  });
  app.post("/api/audio/compatible", async (req, reply) => {
    if (library.mutating)
      throw new UserError("Espera a que termine la operación de archivos.");
    if (audioConversions.size >= 2)
      throw new UserError(
        "Hay dos audios preparándose. Vuelve a intentarlo.",
        429,
      );
    const p = z
      .object({ sourceId: z.string(), revision: z.string() })
      .parse(req.body);
    const controller = new AbortController();
    const disconnected = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    audioConversions.add(controller);
    reply.raw.once("close", disconnected);
    try {
      await library.verifySource(p.sourceId, p.revision);
      const { file } = await library.sourceFile(p.sourceId, p.revision);
      const result = await compatibleWav(file, controller.signal);
      await library.verifySource(p.sourceId, p.revision);
      return reply
        .header("Cache-Control", "no-store")
        .header("X-Cassettes-Audio-Warnings", result.warnings ? "1" : "0")
        .type("audio/wav")
        .send(result.wav);
    } finally {
      audioConversions.delete(controller);
      reply.raw.off("close", disconnected);
    }
  });
  app.get<{ Params: { id: string } }>("/api/audio/:id", async (req, reply) => {
    const { file, loc } = await library.sourceFile(req.params.id);
    const range = req.headers.range;
    const contentType = /\.mp3$/i.test(file)
      ? "audio/mpeg"
      : /\.flac$/i.test(file)
        ? "audio/flac"
        : "audio/wav";
    reply
      .header("Accept-Ranges", "bytes")
      .header("Cache-Control", "no-store")
      .type(contentType);
    if (range) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (!m) return reply.code(416).send();
      const start = Number(m[1]),
        end = m[2] ? Math.min(Number(m[2]), loc.size - 1) : loc.size - 1;
      if (start > end || start >= loc.size)
        return reply
          .code(416)
          .header("Content-Range", `bytes */${loc.size}`)
          .send();
      return reply
        .code(206)
        .header("Content-Range", `bytes ${start}-${end}/${loc.size}`)
        .header("Content-Length", end - start + 1)
        .send(createReadStream(file, { start, end }));
    }
    return reply
      .header("Content-Length", loc.size)
      .send(createReadStream(file));
  });
  const backup = () => {
    catalog.expire();
    const privateSources = new Set(
      (
        catalog.db
          .prepare("SELECT id FROM sources WHERE private_account IS NOT NULL")
          .all() as { id: string }[]
      ).map((s) => s.id),
    );
    const tracks = catalog
      .tracks(true)
      .map((t) => ({
        ...t,
        sources: t.sources
          .filter((s) => !privateSources.has(s.id))
          .map((s) => ({
            ...s,
            ...(s.kind === "youtube"
              ? { restoreScope: "public" as const }
              : {}),
          })),
      }))
      .filter((t) => t.sources.length);
    const exportedTrackIds = new Set(tracks.map((t) => t.id));
    const plans = catalog
      .plans()
      .filter(
        (p) =>
          !p.sides.some((s) =>
            s.tracks.some((t) => privateSources.has(t.sourceId)),
          ),
      );
    return {
      format: "cassettes",
      version: 1,
      createdAt: new Date().toISOString(),
      tracks,
      plans,
      playlists: catalog
        .playlists()
        .filter((p) => !p.private)
        .map((p) => ({
          ...p,
          items: p.items.map((item) =>
            item.trackId && !exportedTrackIds.has(item.trackId)
              ? {
                  ...item,
                  trackId: null,
                  title: "Referencia pendiente de actualizar",
                }
              : item,
          ),
        })),
      operations: catalog.operations(),
      root: catalog.root(),
      notice:
        "El audio no se incluye. Conserva también tu carpeta musical. Las referencias privadas se excluyen.",
    };
  };
  app.get("/api/export", async (_req, reply) =>
    reply
      .header(
        "Content-Disposition",
        'attachment; filename="cassettes-biblioteca.json"',
      )
      .send(backup()),
  );
  app.post("/api/backup", async () => {
    if (
      session ||
      library.lockedSources.size ||
      library.mutating ||
      library.scanState.running ||
      catalog.jobs().some((j) => ["running", "queued"].includes(j.status))
    )
      throw new UserError(
        "Detén las tareas y la reproducción antes de copiar.",
      );
    library.mutating = true;
    try {
      const base = path.join(
        dataDir,
        "backups",
        new Date().toISOString().replace(/[:.]/g, "-"),
      );
      await mkdir(path.join(base, "music"), { recursive: true });
      const { writeFile } = await import("node:fs/promises");
      const data = backup();
      const roots = new Map(catalog.roots().map((r) => [r.id, r]));
      const copied = catalog
        .locations()
        .filter((l) => l.available || l.trashed);
      const multiRoot = new Set(copied.map((l) => l.root_id)).size > 1;
      const prefix = (rootId: string, relative: string) =>
        multiRoot ? path.join(rootId, relative) : relative;
      const locationRoots = new Map(copied.map((l) => [l.id, l.root_id]));
      for (const t of data.tracks)
        for (const s of t.sources)
          for (const l of s.locations) {
            l.relativePath = prefix(l.rootId, l.relativePath);
            if (l.originalPath)
              l.originalPath = prefix(l.rootId, l.originalPath);
            delete l.absolutePath;
          }
      for (const op of data.operations) {
        const rootId = locationRoots.get(op.locationId);
        if (rootId) {
          op.from = prefix(rootId, op.from);
          op.to = prefix(rootId, op.to);
        }
      }
      await writeFile(
        path.join(base, "catalog.json"),
        JSON.stringify(data, null, 2),
      );
      let count = 0;
      for (const loc of copied) {
        const from = await confined(
          roots.get(loc.root_id)!.path,
          loc.relative_path,
        );
        const dest = path.join(
          base,
          "music",
          prefix(loc.root_id, loc.relative_path),
        );
        await mkdir(path.dirname(dest), { recursive: true });
        await copyFile(from, dest);
        count++;
      }
      await writeFile(
        path.join(base, "operations.json"),
        JSON.stringify(catalog.operations()),
      );
      return { path: base, files: count };
    } finally {
      library.mutating = false;
    }
  });
  app.post("/api/restore/preview", async (req) => {
    const data = restoreSchema.parse(req.body);
    const id = uid();
    restoreDrafts.set(id, data);
    return {
      id,
      tracks: data.tracks.length,
      plans: data.plans.length,
      message:
        "Se añadirán referencias y planes; nunca se reemplazan ni borran tus archivos. Los activos locales requieren escaneo de la carpeta.",
    };
  });
  app.post("/api/restore/confirm", async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.body);
    const data = restoreDrafts.get(id);
    if (!data) throw new UserError("Vuelve a seleccionar la copia.");
    if (session || library.scanState.running || library.mutating)
      throw new UserError("Espera a que termine el escaneo o la sesión.");
    library.mutating = true;
    try {
      const result = await restoreCatalog(catalog, library, youtube, data);
      restoreDrafts.delete(id);
      return result;
    } finally {
      library.mutating = false;
    }
  });
  const restoreDrafts = new Map<string, RestoreData>();
  if (existsSync(path.resolve("dist/client/index.html"))) {
    await app.register(staticPlugin, { root: path.resolve("dist/client") });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Ruta desconocida." })
        : reply.sendFile("index.html"),
    );
  }
  let interval: ReturnType<typeof setInterval> | undefined;
  if (options.watch !== false) {
    await library.recover();
    await library.watch();
    void library.scan();
    interval = setInterval(() => {
      if (session && session.expires < Date.now()) release();
      void library.scan();
      catalog.expire();
    }, 60000);
    interval.unref();
    void downloads.enqueue([]).catch(() => {});
  }
  app.addHook("onClose", async () => {
    if (interval) clearInterval(interval);
    for (const controller of audioConversions) controller.abort();
    await downloads.close();
    await library.close();
    catalog.close();
  });
  return { app, catalog, library, youtube, downloads };
}
