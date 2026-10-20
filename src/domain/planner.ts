import {
  type Occurrence,
  type PlanConfig,
  type Plan,
  type Side,
} from "./types";
export function shuffle<T>(items: readonly T[], seed: number): T[] {
  const a = [...items];
  let s = seed | 0;
  const rand = () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
export function validateConfig(c: PlanConfig): void {
  if (
    ![60, 90].includes(c.profile) ||
    ![c.initialMs, c.gapMs, c.finalMs, c.reserveMs, c.seed].every(
      Number.isSafeInteger,
    ) ||
    c.initialMs < 2000 ||
    c.gapMs < 2000 ||
    c.finalMs < 0 ||
    c.reserveMs < 0 ||
    c.initialMs + c.finalMs + c.reserveMs >= c.profile * 30000 ||
    !["order", "optimize"].includes(c.mode) ||
    (c.maxTapes !== null &&
      (!Number.isSafeInteger(c.maxTapes) ||
        c.maxTapes < 1 ||
        c.maxTapes > 1000))
  )
    throw new Error(
      "Configuración de casete no válida. Los silencios inicial y entre pistas deben ser de al menos 2 segundos.",
    );
}
export function sideTiming(tracks: readonly Occurrence[], c: PlanConfig) {
  const programMs = tracks.length
    ? c.initialMs +
      tracks.reduce((s, t) => s + t.durationMs, 0) +
      (tracks.length - 1) * c.gapMs +
      c.finalMs
    : 0;
  const occupiedMs = tracks.length ? programMs + c.reserveMs : 0;
  return { programMs, occupiedMs, freeMs: c.profile * 30000 - occupiedMs };
}
/** El equilibrio se mide entre todas las caras usadas, sin ordenar las cintas. */
function score(bins: Occurrence[][], c: PlanConfig): number[] {
  const used = bins.filter((b) => b.length);
  const loads = used.map((b) => sideTiming(b, c).occupiedMs);
  const total = loads.reduce((a, b) => a + b, 0);
  const spread = loads.length ? Math.max(...loads) - Math.min(...loads) : 0;
  const deviation = loads.reduce(
    (sum, load) => sum + Math.abs(load * loads.length - total),
    0,
  );
  return c.maxTapes === null
    ? [Math.ceil(used.length / 2), used.length, spread, deviation]
    : [
        -used.flat().reduce((sum, t) => sum + t.durationMs, 0),
        -used.flat().length,
        used.length,
        spread,
        deviation,
      ];
}
function better(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!;
  return false;
}
// Cada canción aporta su duración y un intervalo; el intervalo que sobra
// se compensa en la capacidad. Así se incluyen exactamente todas las pausas.
function packingCapacity(c: PlanConfig) {
  return c.profile * 30000 - c.initialMs - c.finalMs - c.reserveMs + c.gapMs;
}
function weight(t: Occurrence, c: PlanConfig) {
  return t.durationMs + c.gapMs;
}
function minimumFaces(input: Occurrence[], c: PlanConfig) {
  const capacity = packingCapacity(c);
  return Math.max(
    Math.ceil(input.reduce((sum, t) => sum + weight(t, c), 0) / capacity),
    input.filter((t) => weight(t, c) > capacity / 2).length,
  );
}
function circularPack(
  input: Occurrence[],
  count: number,
  c: PlanConfig,
  expand: boolean,
) {
  const bins: Occurrence[][] = Array.from({ length: count }, () => []);
  const loads = Array<number>(count).fill(0),
    pending: Occurrence[] = [];
  const capacity = packingCapacity(c);
  let cursor = 0;
  for (const t of input) {
    let placed = false;
    for (let offset = 0; offset < bins.length; offset++) {
      const i = (cursor + offset) % bins.length;
      if (loads[i]! + weight(t, c) > capacity) continue;
      bins[i]!.push(t);
      loads[i]! += weight(t, c);
      cursor = (i + 1) % bins.length;
      placed = true;
      break;
    }
    if (!placed && expand) {
      bins.push([t]);
      loads.push(weight(t, c));
      cursor = 0;
    } else if (!placed) pending.push(t);
  }
  return { bins, loads, pending };
}
type Packing = ReturnType<typeof circularPack>;
/** Recolocar una pista permite encajar otra sin abrir una cara adicional. */
function repair(p: Packing, c: PlanConfig, work: () => boolean) {
  const capacity = packingCapacity(c),
    left: Occurrence[] = [];
  for (const t of p.pending) {
    let placed = false;
    for (let i = 0; i < p.bins.length && !placed; i++) {
      if (p.loads[i]! + weight(t, c) <= capacity) {
        p.bins[i]!.push(t);
        p.loads[i]! += weight(t, c);
        placed = true;
        break;
      }
      for (let j = 0; j < p.bins[i]!.length && !placed; j++) {
        if (!work()) break;
        const old = p.bins[i]![j]!;
        if (p.loads[i]! - weight(old, c) + weight(t, c) > capacity) continue;
        const target = p.loads.findIndex(
          (load, k) => k !== i && load + weight(old, c) <= capacity,
        );
        if (target >= 0) {
          p.bins[i]![j] = t;
          p.loads[i]! += weight(t, c) - weight(old, c);
          p.bins[target]!.push(old);
          p.loads[target]! += weight(old, c);
          placed = true;
        } else if (c.maxTapes !== null && t.durationMs > old.durationMs) {
          p.bins[i]![j] = t;
          p.loads[i]! += weight(t, c) - weight(old, c);
          left.push(old);
          placed = true;
        }
      }
    }
    if (!placed) left.push(t);
  }
  p.pending = left;
}
/** Movimientos e intercambios entre las caras extrema larga/corta.
 * La duración decide si cabe; nunca ordena la secuencia musical. */
function balance(p: Packing, c: PlanConfig, work: () => boolean) {
  const capacity = packingCapacity(c);
  for (let pass = 0; pass < 24; pass++) {
    const used = p.bins
      .map((b, i) => (b.length ? i : -1))
      .filter((i) => i >= 0);
    if (used.length < 2) return;
    const high = used.reduce((a, b) => (p.loads[a]! >= p.loads[b]! ? a : b));
    const low = used.reduce((a, b) => (p.loads[a]! <= p.loads[b]! ? a : b));
    if (high === low) return;
    const diff = p.loads[high]! - p.loads[low]!;
    let bestDiff = diff,
      from = -1,
      to = -1;
    for (let i = 0; i < p.bins[high]!.length; i++) {
      const a = weight(p.bins[high]![i]!, c);
      if (!work()) return;
      if (
        p.bins[high]!.length > 1 &&
        p.loads[low]! + a <= capacity &&
        Math.abs(diff - 2 * a) < bestDiff
      ) {
        bestDiff = Math.abs(diff - 2 * a);
        from = i;
        to = -1;
      }
      for (let j = 0; j < p.bins[low]!.length; j++) {
        if (!work()) return;
        const delta = a - weight(p.bins[low]![j]!, c);
        if (
          p.loads[high]! - delta <= capacity &&
          p.loads[low]! + delta <= capacity &&
          Math.abs(diff - 2 * delta) < bestDiff
        ) {
          bestDiff = Math.abs(diff - 2 * delta);
          from = i;
          to = j;
        }
      }
    }
    if (from < 0) return;
    const a = p.bins[high]![from]!;
    if (to < 0) {
      p.bins[high]!.splice(from, 1);
      p.bins[low]!.push(a);
      p.loads[high]! -= weight(a, c);
      p.loads[low]! += weight(a, c);
    } else {
      const b = p.bins[low]![to]!;
      p.bins[high]![from] = b;
      p.bins[low]![to] = a;
      p.loads[high]! += weight(b, c) - weight(a, c);
      p.loads[low]! += weight(a, c) - weight(b, c);
    }
  }
}
function mixedPacking(valid: Occurrence[], c: PlanConfig, deadline: number) {
  if (!valid.length) return [];
  const lower = minimumFaces(valid, c);
  const limit = Math.min(
    valid.length,
    c.maxTapes === null ? valid.length : c.maxTapes * 2,
  );
  const initial = Math.min(lower, limit);
  const baseline = circularPack(
    shuffle(valid, c.seed),
    initial,
    c,
    c.maxTapes === null,
  );
  let best = baseline.bins.filter((b) => b.length),
    bestScore = score(best, c),
    operations = 0;
  const work = () => ++operations <= 100000 && performance.now() < deadline;
  // Un presupuesto de intentos estable conserva reproducibilidad si no vence
  // el límite de tiempo. Siempre hay una solución válida antes de buscar.
  for (
    let count = initial;
    count <= Math.min(limit, c.maxTapes === null ? best.length : limit);
    count++
  ) {
    let complete = false;
    for (
      let attempt = 0;
      attempt < 32 && performance.now() < deadline;
      attempt++
    ) {
      const p = circularPack(
        shuffle(valid, c.seed + attempt + count * 65537),
        count,
        c,
        false,
      );
      repair(p, c, work);
      if (!p.pending.length) complete = true;
      if (c.maxTapes === null && p.pending.length) continue;
      balance(p, c, work);
      const candidate = p.bins.filter((b) => b.length),
        candidateScore = score(candidate, c);
      if (better(candidateScore, bestScore)) {
        best = candidate;
        bestScore = candidateScore;
      }
    }
    if (complete || performance.now() >= deadline) break;
  }
  return best;
}
export function buildPlan(
  input: Occurrence[],
  c: PlanConfig,
  budgetMs = 350,
): Plan {
  validateConfig(c);
  if (new Set(input.map((t) => t.id)).size !== input.length)
    throw new Error("Las ocurrencias deben tener identificadores únicos.");
  const excluded: Plan["excluded"] = [];
  const valid: Occurrence[] = [];
  for (const t of input) {
    if (!Number.isSafeInteger(t.durationMs) || t.durationMs <= 0)
      excluded.push({
        id: t.id,
        title: t.title,
        reason: "Duración desconocida o inválida",
      });
    else if (sideTiming([t], c).freeMs < 0)
      excluded.push({
        id: t.id,
        title: t.title,
        reason: "No cabe en una cara",
      });
    else valid.push(t);
  }
  const started = performance.now();
  const deadline = started + Math.max(0, budgetMs);
  const sorted = c.mode === "order" ? valid : shuffle(valid, c.seed);
  const limit = c.maxTapes === null ? Infinity : c.maxTapes * 2;
  let bins: Occurrence[][] = [];
  if (c.mode === "optimize") bins = mixedPacking(valid, c, deadline);
  else {
    for (const t of sorted) {
      const last = bins.at(-1);
      if (last && sideTiming([...last, t], c).freeMs >= 0) last.push(t);
      else if (bins.length < limit) bins.push([t]);
      else break;
    }
  }
  let proven = false;
  if (c.mode === "optimize" && valid.length <= 11 && budgetMs > 0) {
    let nodes = 0,
      cut = false,
      best = bins.map((b) => [...b]),
      bestScore = score(best, c);
    const search = (index: number, current: Occurrence[][]) => {
      if (++nodes > 200000 || performance.now() >= deadline) {
        cut = true;
        return;
      }
      if (index === sorted.length) {
        const candidate = score(current, c);
        if (better(candidate, bestScore)) {
          best = current.map((b) => [...b]);
          bestScore = candidate;
        }
        return;
      }
      if (c.maxTapes === null && Math.ceil(current.length / 2) > bestScore[0]!)
        return;
      const t = sorted[index]!;
      const seen = new Set<number>();
      for (const bin of current) {
        const occupied = sideTiming(bin, c).occupiedMs;
        if (seen.has(occupied) || sideTiming([...bin, t], c).freeMs < 0)
          continue;
        seen.add(occupied);
        bin.push(t);
        search(index + 1, current);
        bin.pop();
        if (cut) return;
      }
      if (
        current.length < limit &&
        (c.maxTapes !== null || current.length <= best.length)
      ) {
        current.push([t]);
        search(index + 1, current);
        current.pop();
      }
      if (c.maxTapes !== null && !cut) search(index + 1, current);
    };
    search(0, []);
    bins = best;
    proven = !cut;
  }
  const assigned = new Set(bins.flatMap((b) => b.map((t) => t.id)));
  for (const t of valid)
    if (!assigned.has(t.id))
      excluded.push({
        id: t.id,
        title: t.title,
        reason: "Fuera del límite de cintas",
      });
  const arranged = bins
    .filter((b) => b.length)
    .map((bin, i) => (c.mode === "optimize" ? shuffle(bin, c.seed + i) : bin));
  if (c.mode === "optimize" && arranged.length % 2) arranged.push([]);
  const sides: Side[] = arranged.map((tracks, i) => ({
    id: `${Math.floor(i / 2) + 1}${i % 2 ? "B" : "A"}`,
    tape: Math.floor(i / 2) + 1,
    face: i % 2 ? "B" : "A",
    tracks,
    ...sideTiming(tracks, c),
  }));
  return {
    id: crypto.randomUUID(),
    name: `Mi selección · C${c.profile}`,
    createdAt: new Date().toISOString(),
    config: { ...c },
    sides,
    excluded,
    optimality: proven ? "proven" : "unproven",
    algorithm:
      c.mode === "order"
        ? "preserve-order-v2"
        : "random-circular+repair+bounded-search-v2",
  };
}
