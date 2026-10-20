import type { Plan, Track } from "./types";
import { sideTiming } from "./planner";
export function trackAdditionSource(track: Track, sourceId?: string) {
  return (
    track.sources.find(
      (s) => s.id === sourceId && s.kind === "local" && s.available,
    ) ?? track.sources.find((s) => s.kind === "local" && s.available)
  );
}
/** Preselección por duración de catálogo; añadir verifica después el audio real. */
export function fittingAdditionSource(
  plan: Plan,
  sideId: string,
  track: Track,
  sourceId?: string,
) {
  const side = plan.sides.find((s) => s.id === sideId);
  const source = trackAdditionSource(track, sourceId);
  if (
    !side ||
    !source ||
    source.durationMs === null ||
    !Number.isSafeInteger(source.durationMs) ||
    source.durationMs <= 0
  )
    return undefined;
  const candidate = {
    id: "candidate",
    trackId: track.id,
    sourceId: source.id,
    revision: source.revision,
    kind: source.kind,
    title: track.title,
    artist: track.artist,
    durationMs: source.durationMs,
  };
  return sideTiming([...side.tracks, candidate], plan.config).freeMs >= 0
    ? source
    : undefined;
}
/** Los rótulos son del catálogo; solo el audio y el reparto son instantáneas. */
export function syncPlanTrackMetadata(
  plan: Plan,
  tracks: readonly Pick<Track, "id" | "title" | "artist">[],
): Plan {
  const metadata = new Map(tracks.map((track) => [track.id, track]));
  return {
    ...plan,
    sides: plan.sides.map((side) => ({
      ...side,
      tracks: side.tracks.map((track) => {
        const current = metadata.get(track.trackId);
        return current
          ? { ...track, title: current.title, artist: current.artist }
          : track;
      }),
    })),
  };
}
/** Cambia solo los rótulos: la identidad, el audio y el reparto permanecen. */
export function updatePlanTrackMetadata(
  plan: Plan,
  trackId: string,
  metadata: { title: string; artist: string },
): Plan {
  return {
    ...plan,
    sides: plan.sides.map((side) => ({
      ...side,
      tracks: side.tracks.map((track) =>
        track.trackId === trackId
          ? { ...track, title: metadata.title, artist: metadata.artist }
          : track,
      ),
    })),
  };
}
export function moveOccurrence(
  plan: Plan,
  occurrenceId: string,
  targetSideId: string,
  offset?: number,
): Plan {
  const next = structuredClone(plan);
  const source = next.sides.find((s) =>
    s.tracks.some((t) => t.id === occurrenceId),
  );
  const target = next.sides.find((s) => s.id === targetSideId);
  if (!source || !target)
    throw new Error("No se encuentra la canción o la cara.");
  const index = source.tracks.findIndex((t) => t.id === occurrenceId);
  const [track] = source.tracks.splice(index, 1);
  const position =
    offset === undefined
      ? target.tracks.length
      : Math.max(0, Math.min(target.tracks.length, index + offset));
  target.tracks.splice(position, 0, track!);
  for (const side of new Set([source, target])) {
    const timing = sideTiming(side.tracks, next.config);
    if (timing.freeMs < 0)
      throw new Error(
        "La canción no cabe en esa cara con los silencios y la reserva.",
      );
    Object.assign(side, timing);
  }
  next.id = crypto.randomUUID();
  next.createdAt = new Date().toISOString();
  next.optimality = "unproven";
  return next;
}

function revisedPlan(plan: Plan): Plan {
  return {
    ...structuredClone(plan),
    optimality: "unproven",
    algorithm: "manual-edit-v1",
  };
}
export function addOccurrenceToSide(
  plan: Plan,
  sideId: string,
  track: import("./types").Occurrence,
): Plan {
  if (
    track.kind !== "local" ||
    !Number.isSafeInteger(track.durationMs) ||
    track.durationMs <= 0
  )
    throw new Error("La canción necesita audio local con duración conocida.");
  if (plan.sides.some((s) => s.tracks.some((t) => t.id === track.id)))
    throw new Error("La ocurrencia ya existe en esta selección.");
  if (
    plan.sides.some((s) =>
      s.tracks.some(
        (t) =>
          t.sourceId === track.sourceId &&
          (t.revision !== track.revision || t.durationMs !== track.durationMs),
      ),
    )
  )
    throw new Error(
      "La fuente cambió. Prepara de nuevo la selección antes de añadir esta canción.",
    );
  const next = revisedPlan(plan),
    side = next.sides.find((s) => s.id === sideId);
  if (!side) throw new Error("No se encuentra la cara.");
  side.tracks.push(structuredClone(track));
  const timing = sideTiming(side.tracks, next.config);
  if (timing.freeMs < 0)
    throw new Error(
      "La canción no cabe en esta cara con los silencios y la reserva. No se ha añadido.",
    );
  Object.assign(side, timing);
  return next;
}
export function removeOccurrence(plan: Plan, occurrenceId: string): Plan {
  const next = revisedPlan(plan),
    side = next.sides.find((s) => s.tracks.some((t) => t.id === occurrenceId));
  if (!side) throw new Error("No se encuentra la canción en la selección.");
  side.tracks = side.tracks.filter((t) => t.id !== occurrenceId);
  Object.assign(side, sideTiming(side.tracks, next.config));
  return next;
}
export function copySidesToTape(
  plan: Plan,
  selected: Partial<Record<"A" | "B", string>>,
  name: string,
): Plan {
  if (!name.trim() || name.trim().length > 160)
    throw new Error("Escribe un nombre de hasta 160 caracteres.");
  const config = { ...plan.config, maxTapes: 1, mode: "order" as const };
  const sides = (["A", "B"] as const).map((face) => {
    const id = selected[face],
      source = id ? plan.sides.find((s) => s.id === id) : undefined;
    if (id && !source)
      throw new Error("No se encuentra una de las caras seleccionadas.");
    const tracks = (source?.tracks ?? []).map((t) => ({
      ...t,
      id: crypto.randomUUID(),
    }));
    const timing = sideTiming(tracks, config);
    if (timing.freeMs < 0)
      throw new Error("Una cara supera la capacidad de la cinta.");
    return { id: `1${face}`, tape: 1, face, tracks, ...timing };
  });
  if (!sides.some((s) => s.tracks.length))
    throw new Error("Selecciona al menos una cara con canciones.");
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    createdAt: new Date().toISOString(),
    config,
    sides,
    excluded: [],
    optimality: "unproven",
    algorithm: "manual-copy-v1",
  };
}
