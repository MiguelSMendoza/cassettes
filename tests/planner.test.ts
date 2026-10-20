import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { buildPlan, sideTiming, shuffle } from "../src/domain/planner";
import { defaultConfig, type Occurrence } from "../src/domain/types";
const song = (durationMs: number, id: string): Occurrence => ({
  id,
  trackId: id,
  sourceId: id,
  revision: "1",
  durationMs,
  title: id,
  artist: "",
  kind: "local",
});
describe("tiempos y reparto", () => {
  it("cuenta los nueve intervalos, la reserva y el límite exacto", () => {
    expect(
      sideTiming(
        Array.from({ length: 10 }, (_, i) => song(170000, String(i))),
        defaultConfig,
      ),
    ).toEqual({ programMs: 1741000, occupiedMs: 1751000, freeMs: 49000 });
    const max = 1800000 - 15000;
    expect(buildPlan([song(max, "a")], defaultConfig).sides[0]?.freeMs).toBe(0);
    expect(
      buildPlan([song(max + 1, "b")], defaultConfig).excluded,
    ).toHaveLength(1);
  });
  it("no permite silencios menores de dos segundos o entradas repetidas", () => {
    expect(() => buildPlan([], { ...defaultConfig, gapMs: 1999 })).toThrow();
    expect(() =>
      buildPlan([song(1000, "a"), song(1000, "a")], defaultConfig),
    ).toThrow();
  });
  it("no pierde ocurrencias ni excede caras para conjuntos arbitrarios", () =>
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1000, max: 2900000 }), { maxLength: 40 }),
        (durations) => {
          const input = durations.map((d, i) => song(d, String(i)));
          const plan = buildPlan(input, defaultConfig, 0);
          const ids = [
            ...plan.sides.flatMap((s) => s.tracks.map((t) => t.id)),
            ...plan.excluded.map((e) => e.id),
          ];
          expect(ids.sort()).toEqual(input.map((t) => t.id).sort());
          for (const side of plan.sides)
            expect(side.occupiedMs).toBeLessThanOrEqual(1800000);
        },
      ),
      { numRuns: 70 },
    ));
  it("respeta orden y límite y conserva repeticiones explícitas de una canción", () => {
    const a = song(1000000, "1");
    const b = { ...a, id: "2" };
    const c = song(1000000, "3");
    const p = buildPlan([a, b, c], {
      ...defaultConfig,
      mode: "order",
      maxTapes: 1,
    });
    expect(p.sides.flatMap((s) => s.tracks.map((t) => t.id))).toEqual([
      "1",
      "2",
    ]);
    expect(p.excluded[0]?.id).toBe("3");
  });
  it("mezcla reproducible sin mutar entrada", () => {
    const a = [1, 2, 3, 4, 5];
    expect(shuffle(a, 42)).toEqual(shuffle(a, 42));
    expect(a).toEqual([1, 2, 3, 4, 5]);
  });
  it("vacío no genera caras fantasma y nunca llama óptima a la heurística", () => {
    expect(buildPlan([], defaultConfig).sides).toEqual([]);
    expect(buildPlan([song(1000, "a")], defaultConfig, 0).optimality).toBe(
      "unproven",
    );
  });
});

it("editar orden o mover de cara recalcula sin mutar el plan ni permitir excesos", async () => {
  const { moveOccurrence } = await import("../src/domain/edit-plan");
  const original = buildPlan(
    [song(1000000, "a"), song(800000, "b")],
    defaultConfig,
    0,
  );
  const first = original.sides.find((s) => s.tracks.some((t) => t.id === "a"))!;
  const other = original.sides.find((s) => s.id !== first.id)!;
  expect(() => moveOccurrence(original, "a", other.id)).toThrow("no cabe");
  expect(original.sides.flatMap((s) => s.tracks)).toHaveLength(2);
  const small = buildPlan(
    [song(1000, "1"), song(2000, "2")],
    { ...defaultConfig, mode: "order" },
    0,
  );
  const edited = moveOccurrence(small, "1", small.sides[0]!.id, 1);
  expect(edited.sides[0]?.tracks.map((t) => t.id)).toEqual(["2", "1"]);
  expect(small.sides[0]?.tracks.map((t) => t.id)).toEqual(["1", "2"]);
  expect(edited.id).not.toBe(small.id);
});
