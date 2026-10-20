import type { Plan, Track, Occurrence } from "../domain/types";
import { addOccurrenceToSide, trackAdditionSource } from "../domain/edit-plan";
import { decodeLocalAudio } from "./decode";
import { api } from "../client/api";
/** Misma medición que preparar una selección, sin modificarla si no cabe. */
export async function prepareTrackAddition(
  plan: Plan,
  sideId: string,
  track: Track,
  signal: AbortSignal,
  sourceId?: string,
  recovered?: (warnings: boolean) => void,
): Promise<Plan> {
  signal.throwIfAborted();
  const source = trackAdditionSource(track, sourceId);
  if (!source)
    throw new Error("Esta canción no tiene un archivo local disponible.");
  const context = new AudioContext();
  try {
    const buffer = await decodeLocalAudio(
      context,
      source.id,
      track.title,
      source.revision,
      signal,
      recovered,
    );
    signal.throwIfAborted();
    const item: Occurrence = {
      id: crypto.randomUUID(),
      trackId: track.id,
      sourceId: source.id,
      revision: source.revision,
      title: track.title,
      artist: track.artist,
      kind: "local",
      durationMs: Math.ceil((buffer.length / buffer.sampleRate) * 1000),
    };
    const next = addOccurrenceToSide(plan, sideId, item);
    if (item.durationMs !== source.durationMs) {
      const updated = await api<{ revision: string }>(
        "/sources/duration",
        {
          sourceId: source.id,
          durationMs: item.durationMs,
          revision: source.revision,
        },
        signal,
      );
      for (const side of next.sides)
        for (const t of side.tracks)
          if (t.id === item.id) t.revision = updated.revision;
    }
    signal.throwIfAborted();
    return next;
  } finally {
    await context.close();
  }
}
