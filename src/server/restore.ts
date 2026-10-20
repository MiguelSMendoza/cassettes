import { z } from "zod";
import { stat } from "node:fs/promises";
import { Catalog, type SourceRow, uid } from "./db";
import { Library, confined, hashFile } from "./files";
import { planSchema } from "../domain/schemas";
import { YouTube } from "./youtube";
export const restoreSchema = z.object({
  format: z.literal("cassettes"),
  version: z.literal(1),
  tracks: z
    .array(
      z.object({
        id: z.string().max(160),
        title: z.string().max(2000),
        artist: z.string().max(2000),
        album: z.string().max(2000),
        genres: z.array(z.string().max(100)).max(30),
        hidden: z.boolean(),
        sources: z
          .array(
            z.object({
              id: z.string().max(160),
              kind: z.enum(["local", "youtube"]),
              hash: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .optional(),
              videoId: z
                .string()
                .regex(/^[\w-]{11}$/)
                .optional(),
              durationMs: z.number().int().positive().nullable(),
              revision: z.string().max(160),
              restoreScope: z.literal("public").optional(),
              locations: z
                .array(
                  z.object({
                    id: z.string().optional(),
                    relativePath: z.string().max(4000),
                    size: z.number().int().nonnegative(),
                    trashed: z.boolean().default(false),
                    originalPath: z.string().max(4000).optional(),
                  }),
                )
                .max(20000),
            }),
          )
          .max(100),
      }),
    )
    .max(20000),
  plans: z.array(planSchema).max(1000).default([]),
  playlists: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        localAudio: z.boolean().optional(),
        origin: z
          .discriminatedUnion("kind", [
            z.object({ kind: z.literal("local") }),
            z.object({
              kind: z.literal("youtube"),
              playlistId: z.string().regex(/^[A-Za-z0-9_-]+$/),
              url: z.string().max(2000),
            }),
          ])
          .optional(),
        private: z.boolean(),
        partial: z.boolean(),
        items: z.array(
          z.object({
            id: z.string(),
            trackId: z.string().nullable(),
            title: z.string(),
            videoId: z
              .string()
              .regex(/^[\w-]{11}$/)
              .optional(),
            downloadJobId: z.string().optional(),
          }),
        ),
      }),
    )
    .max(1000)
    .default([]),
  operations: z
    .array(
      z.object({
        id: z.string(),
        action: z.enum(["rename", "trash", "restore"]),
        locationId: z.string(),
        from: z.string(),
        to: z.string(),
        status: z.string(),
        error: z.string().nullable(),
        hash: z.string(),
      }),
    )
    .default([]),
});
export type RestoreData = z.infer<typeof restoreSchema>;
export async function restoreCatalog(
  catalog: Catalog,
  library: Library,
  youtube: YouTube,
  data: RestoreData,
) {
  const root = catalog.root();
  const sourceMap = new Map<
    string,
    { id: string; trackId: string; revision: string; durationMs: number | null }
  >();
  const trackMap = new Map<string, string>();
  const locationMap = new Map<string, string>();
  let missing = 0,
    remotePending = 0;
  const publicInfo = new Map<
    string,
    { id: string; title: string; durationMs: number | null }
  >();
  for (const t of data.tracks)
    for (const s of t.sources)
      if (s.kind === "youtube" && s.videoId && s.restoreScope === "public") {
        try {
          publicInfo.set(
            s.id,
            await youtube.publicInfo(
              `https://www.youtube.com/watch?v=${s.videoId}`,
            ),
          );
        } catch {
          remotePending++;
        }
      }
  for (const t of data.tracks) {
    const locals = t.sources.filter((s) => s.kind === "local" && s.hash);
    const remote = t.sources.filter((s) => publicInfo.has(s.id));
    if (!locals.length && !remote.length) continue;
    const existing = locals
      .map(
        (s) =>
          catalog.db
            .prepare("SELECT * FROM sources WHERE kind='local' AND key=?")
            .get(s.hash) as SourceRow | undefined,
      )
      .find(Boolean);
    const trackId = existing?.track_id ?? t.id;
    trackMap.set(t.id, trackId);
    catalog.db
      .prepare(
        "INSERT OR IGNORE INTO tracks(id,title,artist,album,genres,hidden,overrides) VALUES(?,?,?,?,?,?,?)",
      )
      .run(
        trackId,
        t.title,
        t.artist,
        t.album,
        JSON.stringify(t.genres),
        t.hidden ? 1 : 0,
        JSON.stringify({
          title: t.title,
          artist: t.artist,
          album: t.album,
          genres: t.genres,
        }),
      );
    for (const s of locals) {
      const found = catalog.db
        .prepare("SELECT * FROM sources WHERE kind='local' AND key=?")
        .get(s.hash) as SourceRow | undefined;
      const sourceId = found?.id ?? s.id;
      if (!found)
        catalog.db
          .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)")
          .run(
            sourceId,
            trackId,
            "local",
            s.hash,
            s.durationMs,
            s.revision,
            "{}",
            Date.now(),
            null,
          );
      const actual = catalog.source(sourceId)!;
      sourceMap.set(s.id, {
        id: actual.id,
        trackId: actual.track_id,
        revision: actual.revision,
        durationMs: actual.duration_ms,
      });
      for (const loc of s.locations) {
        try {
          const file = await confined(root.path, loc.relativePath);
          if ((await hashFile(file)) !== s.hash) {
            missing++;
            continue;
          }
          const info = await stat(file);
          const current = catalog.db
            .prepare(
              "SELECT id FROM locations WHERE root_id=? AND relative_path=?",
            )
            .get(root.id, loc.relativePath) as { id: string } | undefined;
          const locationId = current?.id ?? loc.id ?? uid();
          catalog.db
            .prepare(
              "INSERT INTO locations VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(root_id,relative_path) DO UPDATE SET source_id=excluded.source_id,size=excluded.size,mtime=excluded.mtime,available=excluded.available,trashed=excluded.trashed,original_path=excluded.original_path",
            )
            .run(
              locationId,
              sourceId,
              root.id,
              loc.relativePath,
              info.size,
              info.mtimeMs,
              loc.trashed ? 0 : 1,
              loc.trashed ? 1 : 0,
              loc.originalPath ?? null,
            );
          if (loc.id) locationMap.set(loc.id, locationId);
        } catch {
          missing++;
        }
      }
    }
    for (const s of remote) {
      const info = publicInfo.get(s.id)!;
      const actualTrack = youtube.upsert(
        info.id,
        info.title,
        info.durationMs,
        null,
        trackId,
      );
      const actual = catalog.db
        .prepare("SELECT * FROM sources WHERE kind='youtube' AND key=?")
        .get(info.id) as SourceRow;
      sourceMap.set(s.id, {
        id: actual.id,
        trackId: actualTrack,
        revision: actual.revision,
        durationMs: actual.duration_ms,
      });
      trackMap.set(t.id, actualTrack);
    }
  }
  for (const p of data.plans) {
    if (p.sides.some((s) => s.tracks.some((t) => !sourceMap.has(t.sourceId))))
      continue;
    const restored = structuredClone(p);
    for (const side of restored.sides)
      for (const occurrence of side.tracks) {
        const mapped = sourceMap.get(occurrence.sourceId)!;
        occurrence.sourceId = mapped.id;
        occurrence.trackId = mapped.trackId;
        if (
          mapped.durationMs !== occurrence.durationMs ||
          mapped.revision !== occurrence.revision
        ) {
          occurrence.durationMs = 0;
          occurrence.revision = "needs-review";
        }
      }
    catalog.savePlan(restored);
  }
  for (const p of data.playlists) {
    if (p.private) continue;
    const items = p.items.map((i) => ({
      ...i,
      trackId: i.trackId ? (trackMap.get(i.trackId) ?? null) : null,
      title:
        i.trackId && trackMap.has(i.trackId)
          ? (catalog.tracks(true).find((t) => t.id === trackMap.get(i.trackId!))
              ?.title ?? "Referencia pendiente")
          : "Referencia pendiente",
    }));
    catalog.savePlaylist({ ...p, items }, null);
  }
  for (const op of data.operations) {
    const locationId = locationMap.get(op.locationId);
    if (!locationId) continue;
    catalog.saveOperation({
      ...op,
      locationId,
      status: op.status === "committed" ? "committed" : "needsRecovery",
    });
  }
  return { ok: true, missing, remotePending };
}
