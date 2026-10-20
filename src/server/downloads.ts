import {
  mkdir,
  readdir,
  link,
  unlink,
  stat,
  statfs,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { Catalog, uid } from "./db";
import { Library, confined, hashFile, safeName, UserError } from "./files";
import { parseYouTube } from "../domain/youtube";
import { ffmpeg, ffprobe, runYt, hasDownloader } from "./tools";
import type { Job, Playlist } from "../domain/types";
import { z } from "zod";
export class Downloads {
  private current: { id: string; controller: AbortController } | null = null;
  private processing = false;
  private closing = false;
  constructor(
    readonly catalog: Catalog,
    readonly library: Library,
  ) {}
  async enqueue(urls: string[]) {
    if (!hasDownloader() || !existsSync(ffmpeg) || !existsSync(ffprobe))
      throw new UserError(
        "Faltan herramientas de audio. Ejecuta npm run setup:audio.",
      );
    const added: Job[] = [];
    for (const url of urls) {
      let p: ReturnType<typeof parseYouTube>;
      try {
        p = parseYouTube(url);
        if (!p.videoId)
          throw new UserError(
            "Importa la lista y selecciona sus canciones para descargar.",
          );
      } catch (e) {
        const failed: Job = {
          id: uid(),
          url,
          videoId: "",
          status: "failed",
          progress: 0,
          title: "Enlace no válido",
          error: e instanceof Error ? e.message : "Enlace no válido",
          sourceId: null,
        };
        this.catalog.saveJob(failed);
        added.push(failed);
        continue;
      }
      const existing = this.catalog
        .jobs()
        .find(
          (j) =>
            j.videoId === p.videoId &&
            ["queued", "running", "completed"].includes(j.status),
        );
      if (existing) {
        if (
          existing.status !== "completed" ||
          (existing.sourceId &&
            this.catalog
              .tracks(true)
              .some((t) =>
                t.sources.some(
                  (s) => s.id === existing.sourceId && s.available,
                ),
              ))
        ) {
          added.push(existing);
          continue;
        }
      }
      const j: Job = {
        id: uid(),
        url: p.url,
        videoId: p.videoId,
        status: "queued",
        progress: 0,
        title: p.videoId,
        error: null,
        sourceId: null,
      };
      this.catalog.saveJob(j);
      added.push(j);
    }
    void this.process();
    return added;
  }
  /** Enlaza cada ocurrencia con su MP3, incluso tras reintentos o reinicios. */
  syncPlaylists() {
    const jobs = this.catalog.jobs();
    const sources = new Map(
      this.catalog
        .tracks(true)
        .flatMap((t) => t.sources)
        .filter((s) => s.kind === "local" && s.available)
        .map((s) => [s.id, s]),
    );
    for (const p of this.catalog.playlists()) {
      let changed = false;
      for (const item of p.items) {
        if (!item.videoId || !item.downloadJobId) continue;
        const job =
          jobs.find(
            (j) =>
              j.videoId === item.videoId &&
              j.status === "completed" &&
              j.sourceId &&
              sources.has(j.sourceId),
          ) ??
          jobs.find(
            (j) =>
              j.videoId === item.videoId &&
              ["queued", "running"].includes(j.status),
          ) ??
          jobs.find((j) => j.id === item.downloadJobId);
        if (!job) continue;
        const source =
          job.status === "completed" && job.sourceId
            ? sources.get(job.sourceId)
            : undefined;
        if (
          item.downloadJobId !== job.id ||
          item.trackId !== (source?.trackId ?? null)
        ) {
          item.downloadJobId = job.id;
          item.trackId = source?.trackId ?? null;
          changed = true;
        }
      }
      if (changed) this.catalog.updatePlaylist(p);
    }
  }
  async playlist(p: Playlist) {
    p.localAudio = true;
    const tracks = new Map(this.catalog.tracks(true).map((t) => [t.id, t]));
    const pending = p.items
      .map((item) => ({
        item,
        videoId:
          item.videoId ??
          (item.trackId
            ? tracks
                .get(item.trackId)
                ?.sources.find((s) => s.kind === "youtube")?.videoId
            : undefined),
      }))
      .filter(
        ({ item, videoId }) =>
          videoId &&
          !(
            item.trackId &&
            tracks
              .get(item.trackId)
              ?.sources.some((s) => s.kind === "local" && s.available)
          ),
      );
    const jobs = await this.enqueue(
      pending.map(
        ({ videoId }) => `https://www.youtube.com/watch?v=${videoId}`,
      ),
    );
    for (const { item, videoId } of pending) {
      item.videoId = videoId;
      item.downloadJobId = jobs.find((j) => j.videoId === videoId)?.id;
      item.trackId = null;
    }
    this.catalog.savePlaylist(p, p.private ? "google-session" : null);
    this.syncPlaylists();
    return this.catalog.playlists().find((list) => list.id === p.id)!;
  }
  cancel(id: string) {
    if (this.current?.id === id) this.current.controller.abort();
    const j = this.catalog.jobs().find((j) => j.id === id);
    if (j && ["queued", "running"].includes(j.status)) {
      j.status = "cancelled";
      j.error = "Cancelado por el usuario.";
      this.catalog.saveJob(j);
    }
  }
  private async process() {
    if (this.processing) return;
    this.processing = true;
    try {
      let next;
      while (
        !this.closing &&
        (next = this.catalog
          .jobs()
          .reverse()
          .find((j) => j.status === "queued"))
      ) {
        const j = next;
        const controller = new AbortController();
        this.current = { id: j.id, controller };
        j.status = "running";
        this.catalog.saveJob(j);
        const root = this.catalog.root();
        const temp = path.join(root.path, ".cassettes-downloads", j.id);
        try {
          await mkdir(temp, { recursive: true });
          await confined(root.path, path.relative(root.path, temp));
          const disk = await statfs(root.path);
          if (disk.bavail * disk.bsize < 500 * 1024 * 1024)
            throw new UserError(
              "Se necesitan al menos 500 MB libres para preparar la descarga.",
            );
          await runYt(
            [
              "--no-playlist",
              "--newline",
              "--progress",
              "--progress-template",
              "download:PROGRESS:%(progress._percent_str)s",
              "--max-filesize",
              "500M",
              "--socket-timeout",
              "30",
              "--retries",
              "2",
              "--ffmpeg-location",
              path.dirname(ffmpeg),
              "-f",
              "bestaudio/best",
              "-x",
              "--audio-format",
              "mp3",
              "--audio-quality",
              "320K",
              "--write-info-json",
              "--no-embed-metadata",
              "--no-embed-thumbnail",
              "-o",
              path.join(temp, "audio.%(ext)s"),
              "--",
              j.url,
            ],
            {
              signal: controller.signal,
              timeoutMs: 20 * 60000,
              onLine: (line) => {
                const match = /PROGRESS:\s*([\d.]+)/.exec(line);
                if (match) {
                  j.progress = Math.min(99, Number(match[1]));
                  this.catalog.saveJob(j);
                }
              },
            },
          );
          if (controller.signal.aborted) throw new Error("Cancelado");
          const name = (await readdir(temp)).find((n) => n.endsWith(".mp3"));
          if (!name) throw new UserError("La conversión no produjo un MP3.");
          const file = await confined(
            root.path,
            path.relative(root.path, path.join(temp, name)),
          );
          if (!(await stat(file)).size)
            throw new UserError("El archivo está vacío.");
          const infoFiles = (await readdir(temp)).filter((n) =>
            n.endsWith(".info.json"),
          );
          if (infoFiles[0]) {
            try {
              const info = z
                .object({ title: z.string().max(4000) })
                .parse(
                  JSON.parse(
                    await readFile(path.join(temp, infoFiles[0]), "utf8"),
                  ),
                );
              j.title = info.title;
            } catch {
              /* El nombre por ID sigue siendo válido. */
            }
          }
          const hash = await hashFile(file);
          const existing = this.catalog.db
            .prepare("SELECT id FROM sources WHERE kind='local' AND key=?")
            .get(hash) as { id: string } | undefined;
          if (
            existing &&
            this.catalog
              .tracks(true)
              .some((t) =>
                t.sources.some((s) => s.id === existing.id && s.available),
              )
          )
            j.sourceId = existing.id;
          else {
            const filename = `${safeName(j.title).slice(0, 140)} [${j.videoId}].mp3`;
            let destination = filename;
            try {
              await stat(path.join(root.path, destination));
              destination = `YouTube - ${j.videoId} - ${j.id.slice(0, 6)}.mp3`;
            } catch {
              /* El nombre está libre. */
            }
            const to = await confined(root.path, destination, true);
            await link(file, to);
            const knownTrack = (
              this.catalog.db
                .prepare(
                  "SELECT track_id FROM sources WHERE kind='youtube' AND key=?",
                )
                .get(j.videoId) as { track_id: string } | undefined
            )?.track_id;
            j.sourceId = await this.library.indexFile(
              to,
              root.id,
              destination,
              knownTrack,
            );
          }
          j.status = "completed";
          j.progress = 100;
          j.title = j.title || `YouTube - ${j.videoId}.mp3`;
          j.error = null;
        } catch (e) {
          j.status = controller.signal.aborted ? "cancelled" : "failed";
          j.error = e instanceof Error ? e.message : "No se pudo descargar";
        } finally {
          this.catalog.saveJob(j);
          this.syncPlaylists();
          this.current = null;
          for (const name of await readdir(temp).catch(() => []))
            await unlink(path.join(temp, name)).catch(() => {});
        }
      }
    } finally {
      this.processing = false;
    }
  }
  async close() {
    this.closing = true;
    this.current?.controller.abort();
    while (this.processing) await new Promise((r) => setTimeout(r, 25));
  }
}
