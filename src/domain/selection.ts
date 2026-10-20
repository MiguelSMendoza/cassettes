import type { Track, Playlist, Occurrence } from "./types";
export function makeOccurrences(
  input: Track[],
  options: {
    playlist?: Playlist;
    allTracks: Track[];
    keepRepeats: boolean;
    sourceChoices: Record<string, string>;
  },
): Occurrence[] {
  const lookup = new Map(options.allTracks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const rows = options.playlist
    ? options.playlist.items
        .filter((item) => {
          if (!item.trackId) return true;
          if (!options.keepRepeats && seen.has(item.trackId)) return false;
          seen.add(item.trackId);
          return true;
        })
        .map((item) => ({
          id: item.id,
          track: item.trackId ? lookup.get(item.trackId) : undefined,
          title: item.title,
        }))
    : input.map((track) => ({ id: track.id, track, title: track.title }));
  return rows.map(({ id, track, title }) => {
    const source =
      track?.sources.find(
        (s) => s.kind === "local" && s.id === options.sourceChoices[track.id],
      ) ??
      track?.sources.find((s) => s.kind === "local" && s.available) ??
      track?.sources.find((s) => s.kind === "local");
    return {
      id,
      trackId: track?.id ?? "unavailable",
      sourceId: source?.id ?? "missing",
      revision: source?.revision ?? "",
      durationMs: source?.available ? (source.durationMs ?? 0) : 0,
      title: track?.title ?? title,
      artist: track?.artist ?? "",
      kind: source?.kind ?? "local",
      videoId: source?.videoId,
    };
  });
}
