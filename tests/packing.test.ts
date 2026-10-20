import { it, expect } from "vitest";
import { buildPlan } from "../src/domain/planner";
import { defaultConfig, type Occurrence } from "../src/domain/types";
const tracks = (durations: number[]): Occurrence[] =>
  durations.map((durationMs, i) => ({
    id: String(i),
    trackId: String(i),
    sourceId: String(i),
    title: String(i),
    artist: "",
    revision: "r",
    kind: "local",
    durationMs,
  }));
it("mezcla largas y cortas entre caras, con variedad de asignación entre semillas", () => {
  const input = tracks(
    Array.from({ length: 20 }, (_, i) => (i < 10 ? 240000 : 60000)),
  );
  const assignments = new Set<string>();
  for (const seed of [1, 2, 3, 4]) {
    const p = buildPlan(input, { ...defaultConfig, seed }, 1500);
    const used = p.sides.filter((s) => s.tracks.length);
    expect(used).toHaveLength(2);
    for (const side of used) {
      const long = side.tracks.filter((t) => t.durationMs === 240000).length;
      expect(long).toBeGreaterThanOrEqual(3);
      expect(long).toBeLessThanOrEqual(7);
    }
    assignments.add(
      used[0]!.tracks
        .map((t) => t.id)
        .sort()
        .join(","),
    );
  }
  expect(assignments.size).toBeGreaterThan(1);
});
it("calcula el mínimo con pausas y respeta canciones indivisibles", () => {
  const p = buildPlan(tracks([960000, 960000, 960000]), defaultConfig, 1500);
  expect(p.sides.filter((s) => s.tracks.length)).toHaveLength(3);
  expect(p.sides.at(-1)?.tracks).toHaveLength(0);
  expect(p.excluded).toHaveLength(0);
  const almost = buildPlan(
    tracks([890000, 890000]),
    { ...defaultConfig, gapMs: 10000 },
    1500,
  );
  expect(almost.sides.filter((s) => s.tracks.length)).toHaveLength(2);
});
it("equilibra globalmente las caras y reproduce el resultado con la misma semilla", () => {
  const input = tracks(Array.from({ length: 30 }, (_, i) => 120000 + i * 7301));
  const before = JSON.stringify(input);
  const a = buildPlan(input, defaultConfig, 1500),
    b = buildPlan(input, defaultConfig, 1500);
  expect(a.sides).toEqual(b.sides);
  const used = a.sides.filter((s) => s.tracks.length);
  expect(
    Math.max(...used.map((s) => s.occupiedMs)) -
      Math.min(...used.map((s) => s.occupiedMs)),
  ).toBeLessThan(90000);
  expect(a.excluded).toHaveLength(0);
  expect(JSON.stringify(input)).toBe(before);
});
it("no acepta un mínimo teórico imposible a costa de perder canciones", () => {
  const p = buildPlan(tracks(Array(5).fill(660000)), defaultConfig, 1500);
  expect(p.sides.flatMap((s) => s.tracks)).toHaveLength(5);
  expect(p.sides.filter((s) => s.tracks.length)).toHaveLength(3);
  expect(p.excluded).toHaveLength(0);
});

it("coincide con enumeración independiente en conjuntos pequeños, también con límite de cintas", () => {
  const config = {
    ...defaultConfig,
    initialMs: 2000,
    gapMs: 2000,
    reserveMs: 0,
  };
  // Pesos exactos en minutos: duración + intervalo. No depende del
  // comparador ni de la función de tiempos del planificador.
  const durations = [17, 13, 11, 9, 7, 5].map((n) => n * 60000 - 2000);
  const input = tracks(durations);
  for (const maxTapes of [null, 1] as const) {
    let best: number[] | undefined;
    const compare = (a: number[], b: number[]) => {
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i]! - b[i]!;
      }
      return 0;
    };
    const evaluate = (bins: number[][]) => {
      const loads = bins.map((b) =>
        b.reduce((sum, i) => sum + durations[i]! + 2000, 0),
      );
      const total = loads.reduce((a, b) => a + b, 0),
        count = bins.flat().length;
      const range = loads.length ? Math.max(...loads) - Math.min(...loads) : 0;
      const deviation = loads.reduce(
        (sum, x) => sum + Math.abs(x * loads.length - total),
        0,
      );
      return maxTapes === null
        ? [Math.ceil(bins.length / 2), bins.length, range, deviation]
        : [-(total - count * 2000), -count, bins.length, range, deviation];
    };
    const visit = (index: number, bins: number[][]) => {
      if (index === input.length) {
        const value = evaluate(bins);
        if (!best || compare(value, best) < 0) best = value;
        return;
      }
      for (const bin of bins)
        if (
          bin.reduce((sum, i) => sum + durations[i]! + 2000, 0) +
            durations[index]! +
            2000 <=
          1800000
        ) {
          bin.push(index);
          visit(index + 1, bins);
          bin.pop();
        }
      if (maxTapes === null || bins.length < 2) {
        bins.push([index]);
        visit(index + 1, bins);
        bins.pop();
      }
      if (maxTapes !== null) visit(index + 1, bins);
    };
    visit(0, []);
    const p = buildPlan(input, { ...config, maxTapes }, 1500);
    expect(p.optimality).toBe("proven");
    expect(
      evaluate(
        p.sides
          .filter((s) => s.tracks.length)
          .map((s) => s.tracks.map((t) => Number(t.id))),
      ),
    ).toEqual(best);
  }
});

it("mantiene identidades y capacidad con búsqueda y límites para entradas arbitrarias", async () => {
  const { default: fc } = await import("fast-check");
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 1000, max: 2800000 }), { maxLength: 35 }),
      fc.boolean(),
      (durations, limited) => {
        const input = tracks(durations);
        const p = buildPlan(
          input,
          { ...defaultConfig, maxTapes: limited ? 2 : null },
          100,
        );
        const assigned = p.sides.flatMap((s) => s.tracks);
        const ids = [
          ...assigned.map((t) => t.id),
          ...p.excluded.map((t) => t.id),
        ].sort();
        expect(ids).toEqual(input.map((t) => t.id).sort());
        if (!limited)
          expect(assigned).toHaveLength(
            input.filter((t) => t.durationMs <= 1785000).length,
          );
        else expect(p.sides.length).toBeLessThanOrEqual(4);
        for (const s of p.sides)
          expect(s.occupiedMs).toBeLessThanOrEqual(1800000);
      },
    ),
    { numRuns: 80, seed: 20261015 },
  );
});
