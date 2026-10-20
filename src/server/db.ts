import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  updatePlanTrackMetadata,
  syncPlanTrackMetadata,
} from "../domain/edit-plan";
import type {
  Job,
  Operation,
  Plan,
  Playlist,
  Source,
  Track,
  Location,
} from "../domain/types";
export interface SourceRow {
  id: string;
  track_id: string;
  kind: "local" | "youtube";
  key: string;
  duration_ms: number | null;
  revision: string;
  metadata: string;
  fetched_at: number;
  private_account: string | null;
}
export interface LocationRow {
  id: string;
  source_id: string;
  root_id: string;
  relative_path: string;
  size: number;
  mtime: number;
  available: number;
  trashed: number;
  original_path: string | null;
}
export interface TrackRow {
  id: string;
  title: string;
  artist: string;
  album: string;
  genres: string;
  disc: number | null;
  track_number: number | null;
  hidden: number;
  overrides: string;
}
export interface RootRow {
  id: string;
  path: string;
}
export const uid = () => crypto.randomUUID();
export class Catalog {
  readonly db: Database.Database;
  constructor(readonly dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "catalog.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS roots(id TEXT PRIMARY KEY,path TEXT NOT NULL UNIQUE);
 CREATE TABLE IF NOT EXISTS tracks(id TEXT PRIMARY KEY,title TEXT NOT NULL,artist TEXT NOT NULL DEFAULT '',album TEXT NOT NULL DEFAULT '',genres TEXT NOT NULL DEFAULT '[]',disc INTEGER,track_number INTEGER,hidden INTEGER NOT NULL DEFAULT 0,overrides TEXT NOT NULL DEFAULT '{}');
 CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,track_id TEXT NOT NULL REFERENCES tracks(id),kind TEXT NOT NULL,key TEXT NOT NULL,duration_ms INTEGER,revision TEXT NOT NULL,metadata TEXT NOT NULL DEFAULT '{}',fetched_at INTEGER NOT NULL,private_account TEXT,UNIQUE(kind,key));
 CREATE TABLE IF NOT EXISTS locations(id TEXT PRIMARY KEY,source_id TEXT NOT NULL REFERENCES sources(id),root_id TEXT NOT NULL REFERENCES roots(id),relative_path TEXT NOT NULL,size INTEGER NOT NULL,mtime REAL NOT NULL,available INTEGER NOT NULL DEFAULT 1,trashed INTEGER NOT NULL DEFAULT 0,original_path TEXT,UNIQUE(root_id,relative_path));
 CREATE INDEX IF NOT EXISTS locations_source ON locations(source_id);
 CREATE INDEX IF NOT EXISTS sources_track ON sources(track_id);
 CREATE TABLE IF NOT EXISTS plans(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS playlists(id TEXT PRIMARY KEY,data TEXT NOT NULL,private_account TEXT,fetched_at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 INSERT OR IGNORE INTO migrations VALUES(1,datetime('now'));`);
    if (
      !this.db.prepare("SELECT version FROM migrations WHERE version=2").get()
    ) {
      this.db.transaction(() => {
        this.db
          .exec(`CREATE TABLE library_entries(root_id TEXT NOT NULL REFERENCES roots(id),relative_path TEXT NOT NULL,PRIMARY KEY(root_id,relative_path));
          INSERT INTO library_entries SELECT id,'' FROM roots;
          INSERT INTO migrations VALUES(2,datetime('now'));`);
      })();
    }
    this.expire(true);
    for (const j of this.jobs())
      if (j.status === "running") {
        j.status = "failed";
        j.error =
          "La aplicación se cerró durante la descarga. Puedes reintentar.";
        this.saveJob(j);
      }
  }
  getSetting(key: string) {
    return (
      this.db.prepare("SELECT value FROM settings WHERE key=?").get(key) as
        { value: string } | undefined
    )?.value;
  }
  setSetting(key: string, value: string) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, value);
  }
  root(): RootRow {
    const id = this.getSetting("root");
    const row = this.db
      .prepare("SELECT * FROM roots WHERE id=?")
      .get(id ?? "") as RootRow | undefined;
    if (!row) throw new Error("Carpeta no configurada.");
    return row;
  }
  roots(): RootRow[] {
    return this.db.prepare("SELECT * FROM roots").all() as RootRow[];
  }
  ensureRoot(directory: string): RootRow {
    let r = this.db
      .prepare("SELECT * FROM roots WHERE path=?")
      .get(directory) as RootRow | undefined;
    if (!r) {
      r = { id: uid(), path: directory };
      this.db.prepare("INSERT INTO roots VALUES(@id,@path)").run(r);
    }
    return r;
  }
  includePath(rootId: string, relativePath = "") {
    this.db
      .prepare("INSERT OR IGNORE INTO library_entries VALUES(?,?)")
      .run(rootId, relativePath);
  }
  entries(): {
    rootId: string;
    relativePath: string;
    path: string;
    kind: "file" | "folder";
  }[] {
    return (
      this.db
        .prepare(
          "SELECT e.root_id AS rootId,e.relative_path AS relativePath,r.path AS base FROM library_entries e JOIN roots r ON r.id=e.root_id",
        )
        .all() as { rootId: string; relativePath: string; base: string }[]
    ).map((e) => ({
      rootId: e.rootId,
      relativePath: e.relativePath,
      path: path.join(e.base, e.relativePath),
      kind: e.relativePath ? "file" : "folder",
    }));
  }
  setRoot(directory: string): RootRow {
    const r = this.ensureRoot(directory);
    this.includePath(r.id);
    this.setSetting("root", r.id);
    return r;
  }
  source(id: string) {
    return this.db.prepare("SELECT * FROM sources WHERE id=?").get(id) as
      SourceRow | undefined;
  }
  location(id: string) {
    return this.db.prepare("SELECT * FROM locations WHERE id=?").get(id) as
      LocationRow | undefined;
  }
  locations() {
    return this.db.prepare("SELECT * FROM locations").all() as LocationRow[];
  }
  tracks(includeHidden = false): Track[] {
    const roots = new Map(this.roots().map((r) => [r.id, r.path]));
    const locations = this.locations();
    const sources = this.db
      .prepare("SELECT * FROM sources")
      .all() as SourceRow[];
    const sourceGroups = new Map<string, SourceRow[]>();
    for (const s of sources) {
      const group = sourceGroups.get(s.track_id) ?? [];
      group.push(s);
      sourceGroups.set(s.track_id, group);
    }
    const locationGroups = new Map<string, LocationRow[]>();
    for (const l of locations) {
      const group = locationGroups.get(l.source_id) ?? [];
      group.push(l);
      locationGroups.set(l.source_id, group);
    }
    return (
      this.db
        .prepare("SELECT * FROM tracks ORDER BY rowid DESC")
        .all() as TrackRow[]
    )
      .filter((t) => includeHidden || !t.hidden)
      .map((t) => {
        const overrides = JSON.parse(t.overrides) as Partial<
          Pick<Track, "title" | "artist" | "album" | "genres">
        >;
        return {
          id: t.id,
          title: t.title,
          artist: t.artist,
          album: t.album,
          genres: JSON.parse(t.genres) as string[],
          disc: t.disc,
          trackNumber: t.track_number,
          hidden: !!t.hidden,
          ...overrides,
          sources: (sourceGroups.get(t.id) ?? []).map((s) => {
            const ls: Location[] = (locationGroups.get(s.id) ?? []).map(
              (l) => ({
                id: l.id,
                name: path.basename(l.original_path ?? l.relative_path),
                originalPath: l.original_path ?? undefined,
                relativePath: l.relative_path,
                absolutePath: path.join(
                  roots.get(l.root_id) ?? "",
                  l.relative_path,
                ),
                size: l.size,
                available: !!l.available && !l.trashed,
                trashed: !!l.trashed,
                rootId: l.root_id,
              }),
            );
            return {
              id: s.id,
              trackId: t.id,
              kind: s.kind,
              durationMs: s.duration_ms,
              revision: s.revision,
              videoId: s.kind === "youtube" ? s.key : undefined,
              hash: s.kind === "local" ? s.key : undefined,
              locations: ls,
              available:
                s.kind === "youtube"
                  ? s.duration_ms !== null &&
                    s.fetched_at > Date.now() - 30 * 86400000
                  : ls.some((l) => l.available),
            } satisfies Source;
          }),
        };
      });
  }
  plans(): Plan[] {
    const metadata = (
      this.db
        .prepare("SELECT id,title,artist,overrides FROM tracks")
        .all() as Pick<TrackRow, "id" | "title" | "artist" | "overrides">[]
    ).map((track) => {
      const current = JSON.parse(track.overrides) as Partial<
        Pick<Track, "title" | "artist">
      >;
      return {
        id: track.id,
        title: current.title ?? track.title,
        artist: current.artist ?? track.artist,
      };
    });
    return (
      this.db.prepare("SELECT data FROM plans ORDER BY rowid DESC").all() as {
        data: string;
      }[]
    ).map((r) => syncPlanTrackMetadata(JSON.parse(r.data) as Plan, metadata));
  }
  savePlan(p: Plan) {
    this.db
      .prepare(
        "INSERT INTO plans VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(p.id, JSON.stringify(p));
  }
  editTrack(
    id: string,
    changes: Pick<Track, "title" | "artist" | "album" | "genres">,
  ) {
    return this.db.transaction(() => {
      const updated = this.db
        .prepare("UPDATE tracks SET overrides=? WHERE id=?")
        .run(JSON.stringify(changes), id);
      if (!updated.changes) return false;
      for (const plan of this.plans()) {
        if (
          plan.sides.some((side) =>
            side.tracks.some((track) => track.trackId === id),
          )
        )
          this.savePlan(updatePlanTrackMetadata(plan, id, changes));
      }
      for (const playlist of this.playlists()) {
        if (playlist.items.some((item) => item.trackId === id))
          this.updatePlaylist({
            ...playlist,
            items: playlist.items.map((item) =>
              item.trackId === id ? { ...item, title: changes.title } : item,
            ),
          });
      }
      return true;
    })();
  }
  playlists(): Playlist[] {
    return (
      this.db
        .prepare("SELECT data FROM playlists ORDER BY rowid DESC")
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Playlist);
  }
  deletePlaylist(id: string) {
    this.db.prepare("DELETE FROM playlists WHERE id=?").run(id);
  }
  updatePlaylist(p: Playlist) {
    this.db
      .prepare("UPDATE playlists SET data=? WHERE id=?")
      .run(JSON.stringify(p), p.id);
  }
  savePlaylist(p: Playlist, account: string | null) {
    this.db
      .prepare(
        "INSERT INTO playlists VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,private_account=excluded.private_account,fetched_at=excluded.fetched_at",
      )
      .run(p.id, JSON.stringify(p), account, Date.now());
  }
  jobs(): Job[] {
    return (
      this.db.prepare("SELECT data FROM jobs ORDER BY rowid DESC").all() as {
        data: string;
      }[]
    ).map((r) => JSON.parse(r.data) as Job);
  }
  saveJob(j: Job) {
    this.db
      .prepare(
        "INSERT INTO jobs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(j.id, JSON.stringify(j));
  }
  operations(): Operation[] {
    return (
      this.db
        .prepare("SELECT data FROM operations ORDER BY rowid DESC")
        .all() as { data: string }[]
    ).map((r) => JSON.parse(r.data) as Operation);
  }
  saveOperation(o: Operation) {
    this.db
      .prepare(
        "INSERT INTO operations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      )
      .run(o.id, JSON.stringify(o));
  }
  expire(privateOnly = false) {
    const stale = this.db
      .prepare(
        "SELECT * FROM sources WHERE kind='youtube' AND (fetched_at<? OR (?=1 AND private_account IS NOT NULL))",
      )
      .all(Date.now() - 30 * 86400000, privateOnly ? 1 : 0) as SourceRow[];
    for (const s of stale) {
      this.db
        .prepare(
          "UPDATE sources SET duration_ms=NULL,metadata='{}',fetched_at=0 WHERE id=?",
        )
        .run(s.id);
      this.db
        .prepare(
          "UPDATE tracks SET title='Referencia pendiente de actualizar',artist='' WHERE id=? AND overrides='{}' AND NOT EXISTS(SELECT 1 FROM sources WHERE track_id=? AND kind='local')",
        )
        .run(s.track_id, s.track_id);
      for (const p of this.plans()) {
        let changed = false;
        for (const side of p.sides)
          for (const t of side.tracks)
            if (t.sourceId === s.id) {
              t.title = "Referencia pendiente de actualizar";
              t.durationMs = 0;
              if (s.private_account) {
                delete t.videoId;
                t.sourceId = `private-removed:${t.id}`;
              }
              changed = true;
            }
        if (changed) this.savePlan(p);
      }
      // Local lists survive cache expiry, but cached private titles must not.
      for (const playlist of this.playlists()) {
        if (playlist.origin?.kind !== "local") continue;
        let changed = false;
        for (const item of playlist.items) {
          if (item.trackId !== s.track_id) continue;
          const other = this.db
            .prepare(
              "SELECT id FROM sources WHERE track_id=? AND id<>? AND private_account IS NULL LIMIT 1",
            )
            .get(s.track_id, s.id);
          if (!other || s.private_account) {
            if (s.private_account && !other) item.trackId = null;
            item.title = "Referencia pendiente de actualizar";
            changed = true;
          }
        }
        if (changed) this.savePlaylist(playlist, null);
      }
      if (s.private_account) {
        this.db.prepare("DELETE FROM sources WHERE id=?").run(s.id);
        const local = this.db
          .prepare(
            "SELECT l.relative_path FROM locations l JOIN sources so ON so.id=l.source_id WHERE so.track_id=? AND so.kind='local' LIMIT 1",
          )
          .get(s.track_id) as { relative_path: string } | undefined;
        if (local)
          this.db
            .prepare("UPDATE tracks SET title=? WHERE id=? AND overrides='{}'")
            .run(path.basename(local.relative_path), s.track_id);
        else
          this.db
            .prepare(
              "DELETE FROM tracks WHERE id=? AND NOT EXISTS(SELECT 1 FROM sources WHERE track_id=?)",
            )
            .run(s.track_id, s.track_id);
      }
    }
    this.db
      .prepare(
        "DELETE FROM playlists WHERE (COALESCE(json_extract(data, '$.origin.kind'), 'youtube') <> 'local' AND COALESCE(json_extract(data, '$.localAudio'), 0)<>1 AND fetched_at<?) OR (?=1 AND private_account IS NOT NULL)",
      )
      .run(Date.now() - 30 * 86400000, privateOnly ? 1 : 0);
  }
  close() {
    this.db.close();
  }
}
