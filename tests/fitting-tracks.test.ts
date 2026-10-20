import { expect, it } from "vitest";
import { fittingAdditionSource } from "../src/domain/edit-plan";
import { buildPlan } from "../src/domain/planner";
import { defaultConfig, type Track } from "../src/domain/types";

const track = (durationMs: number | null): Track => ({
  id: "new",
  title: "Nueva",
  artist: "",
  album: "",
  genres: [],
  disc: null,
  trackNumber: null,
  hidden: false,
  sources: [
    {
      id: "s",
      trackId: "new",
      kind: "local",
      available: true,
      revision: "r",
      locations: [],
      durationMs,
    },
  ],
});
it("filtra por capacidad exacta incluyendo pausa adicional y reserva, sin redondeos", () => {
  const plan = buildPlan(
    [
      {
        id: "one",
        trackId: "one",
        sourceId: "one",
        revision: "r",
        kind: "local",
        title: "Una",
        artist: "",
        durationMs: 1000,
      },
    ],
    defaultConfig,
  );
  expect(fittingAdditionSource(plan, "1A", track(1780000))?.id).toBe("s");
  expect(fittingAdditionSource(plan, "1A", track(1780001))).toBeUndefined();
  const empty = {
    ...plan,
    sides: plan.sides.map((s) => ({ ...s, tracks: [] })),
  };
  expect(fittingAdditionSource(empty, "1A", track(1785000))?.id).toBe("s");
  expect(fittingAdditionSource(empty, "1A", track(1785001))).toBeUndefined();
});
it("solo ofrece audio local disponible con duración válida y respeta la fuente elegida", () => {
  const plan = buildPlan([], defaultConfig);
  plan.sides = [
    {
      id: "1A",
      tape: 1,
      face: "A",
      tracks: [],
      programMs: 0,
      occupiedMs: 0,
      freeMs: 1800000,
    },
  ];
  for (const value of [null, 0, -1, 1.5, NaN])
    expect(fittingAdditionSource(plan, "1A", track(value))).toBeUndefined();
  const t = track(1000);
  t.sources.push({ ...t.sources[0]!, id: "long", durationMs: 1800000 });
  expect(fittingAdditionSource(plan, "1A", t, "long")).toBeUndefined();
  expect(fittingAdditionSource(plan, "1A", t)?.id).toBe("s");
  t.sources.forEach((s) => (s.available = false));
  expect(fittingAdditionSource(plan, "1A", t)).toBeUndefined();
  expect(fittingAdditionSource(plan, "missing", track(1))).toBeUndefined();
});
