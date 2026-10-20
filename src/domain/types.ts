export type Kind = "local" | "youtube";
export interface Location {
  id: string;
  name: string;
  relativePath: string;
  absolutePath?: string;
  size: number;
  available: boolean;
  trashed: boolean;
  rootId: string;
  originalPath?: string;
}
export interface Source {
  id: string;
  trackId: string;
  kind: Kind;
  durationMs: number | null;
  revision: string;
  videoId?: string;
  hash?: string;
  locations: Location[];
  available: boolean;
}
export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  genres: string[];
  disc: number | null;
  trackNumber: number | null;
  hidden: boolean;
  sources: Source[];
}
export interface Root {
  id: string;
  path: string;
  writable: boolean;
  connected: boolean;
}
export interface Occurrence {
  id: string;
  trackId: string;
  sourceId: string;
  revision: string;
  durationMs: number;
  title: string;
  artist: string;
  kind: Kind;
  videoId?: string;
}
export interface PlanConfig {
  profile: 60 | 90;
  initialMs: number;
  gapMs: number;
  finalMs: number;
  reserveMs: number;
  mode: "optimize" | "order";
  maxTapes: number | null;
  seed: number;
}
export interface Side {
  id: string;
  tape: number;
  face: "A" | "B";
  tracks: Occurrence[];
  programMs: number;
  occupiedMs: number;
  freeMs: number;
}
export interface Plan {
  id: string;
  name: string;
  createdAt: string;
  config: PlanConfig;
  sides: Side[];
  excluded: { title: string; reason: string; id: string }[];
  optimality: "proven" | "unproven";
  algorithm: string;
}
export interface Playlist {
  localAudio?: boolean;
  origin?:
    { kind: "local" } | { kind: "youtube"; playlistId: string; url: string };
  id: string;
  name: string;
  private: boolean;
  items: {
    id: string;
    trackId: string | null;
    title: string;
    videoId?: string;
    downloadJobId?: string;
  }[];
  partial: boolean;
}
export interface Job {
  id: string;
  url: string;
  videoId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  title: string;
  error: string | null;
  sourceId: string | null;
}
export interface Operation {
  id: string;
  action: "rename" | "trash" | "restore";
  locationId: string;
  from: string;
  to: string;
  status: string;
  error: string | null;
  hash: string;
}
export interface Snapshot {
  tracks: Track[];
  roots: Root[];
  libraryPaths: { path: string; kind: "file" | "folder" }[];
  root: Root;
  plans: Plan[];
  playlists: Playlist[];
  jobs: Job[];
  operations: Operation[];
  scan: {
    running: boolean;
    processed: number;
    errors: string[];
    lastRun: string | null;
  };
  google: { configured: boolean; connected: boolean };
  audio: { downloader: boolean; ffmpeg: boolean };
  session: { id: string; sourceIds: string[] } | null;
}
export const defaultConfig: PlanConfig = {
  profile: 60,
  initialMs: 5000,
  gapMs: 4000,
  finalMs: 0,
  reserveMs: 10000,
  mode: "optimize",
  maxTapes: null,
  seed: 1,
};
export function displayTime(ms: number): string {
  const total = Math.ceil(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
