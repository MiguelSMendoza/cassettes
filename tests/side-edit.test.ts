import { it, expect } from "vitest";
import {
  addOccurrenceToSide,
  removeOccurrence,
  copySidesToTape,
} from "../src/domain/edit-plan";
import { buildPlan, sideTiming } from "../src/domain/planner";
import { defaultConfig, type Occurrence } from "../src/domain/types";
const song = (id: string, durationMs = 1000): Occurrence => ({
  id,
  trackId: id,
  sourceId: id,
  revision: "r",
  kind: "local",
  title: id,
  artist: "",
  durationMs,
});
it("añadir recalcula pausas/reserva, permite igualdad exacta y rechaza exceso sin mutar", () => {
  const p = buildPlan([song("one")], defaultConfig, 0),
    before = JSON.stringify(p);
  const next = addOccurrenceToSide(p, "1A", song("two", 1780000));
  expect(next.sides[0]?.freeMs).toBe(0);
  expect(next.sides[0]).toMatchObject(
    sideTiming(next.sides[0]!.tracks, p.config),
  );
  expect(() => addOccurrenceToSide(p, "1A", song("bad", 1780001))).toThrow(
    "no cabe",
  );
  expect(JSON.stringify(p)).toBe(before);
  expect(() => addOccurrenceToSide(p, "missing", song("x"))).toThrow();
  expect(() => addOccurrenceToSide(p, "1A", song("one"))).toThrow();
  expect(() => addOccurrenceToSide(p, "1A", song("zero", 0))).toThrow();
});
it("quitar solo la ocurrencia elegida conserva biblioteca referenciada y deja la cara vacía sin pausas", () => {
  const original = song("one"),
    repeat = { ...original, id: "repeat" };
  const p = buildPlan([original, repeat], defaultConfig, 0);
  const before = JSON.stringify(p);
  const one = removeOccurrence(p, "one");
  expect(one.sides.flatMap((s) => s.tracks).map((t) => t.id)).toEqual([
    "repeat",
  ]);
  expect(one.excluded).toEqual([]);
  const empty = removeOccurrence(one, "repeat");
  expect(empty.sides[0]).toMatchObject({
    tracks: [],
    programMs: 0,
    occupiedMs: 0,
    freeMs: 1800000,
  });
  expect(JSON.stringify(p)).toBe(before);
  expect(() => removeOccurrence(p, "missing")).toThrow();
});
it("copiar caras crea una cinta independiente con nuevas ocurrencias, mismo audio/orden y dos caras", () => {
  const p = buildPlan([song("one")], defaultConfig, 0);
  p.sides.push({
    ...p.sides[0]!,
    id: "3B",
    tape: 3,
    face: "B",
    tracks: [song("other")],
  });
  const before = JSON.stringify(p);
  const copied = copySidesToTape(p, { A: "3B", B: "1A" }, "Separada");
  expect(copied.name).toBe("Separada");
  expect(copied.id).not.toBe(p.id);
  expect(copied.config.maxTapes).toBe(1);
  expect(copied.sides.map((s) => s.id)).toEqual(["1A", "1B"]);
  expect(copied.sides[0]?.tracks[0]?.sourceId).toBe("other");
  expect(copied.sides[0]?.tracks[0]?.id).not.toBe("other");
  copied.sides[0]!.tracks[0]!.title = "Independiente";
  expect(JSON.stringify(p)).toBe(before);
  const single = copySidesToTape(p, { B: "3B" }, "Solo B");
  expect(single.sides[0]).toMatchObject({
    tracks: [],
    programMs: 0,
    occupiedMs: 0,
  });
  expect(single.sides[1]?.tracks).toHaveLength(1);
  expect(() => copySidesToTape(p, {}, "Vacía")).toThrow();
  expect(() => copySidesToTape(p, { A: "missing" }, "X")).toThrow();
});

it("la cinta exportada y sus ediciones se guardan sin sobrescribir origen ni crear copias por cada cambio", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const { createApp } = await import("../src/server/app");
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-side-save-"));
  let ctx = await createApp({ dataDir: dir, watch: false });
  try {
    ctx.catalog.db
      .prepare("INSERT INTO tracks(id,title) VALUES(?,?)")
      .run("one", "one");
    ctx.catalog.db
      .prepare("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)")
      .run("one", "one", "local", "hash", 1000, "r", "{}", Date.now(), null);
    const original = buildPlan([song("one")], defaultConfig, 0);
    ctx.catalog.savePlan(original);
    const copied = copySidesToTape(original, { A: "1A" }, "Independiente");
    const added = addOccurrenceToSide(copied, "1B", {
      ...song("repeat"),
      trackId: "one",
      sourceId: "one",
    });
    expect(added.id).toBe(copied.id);
    for (const plan of [
      copied,
      added,
      removeOccurrence(added, added.sides[0]!.tracks[0]!.id),
    ]) {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { "x-cassettes-client": "local" },
        payload: plan,
      });
      expect(response.statusCode).toBe(200);
    }
    await ctx.app.close();
    ctx = await createApp({ dataDir: dir, watch: false });
    expect(ctx.catalog.plans()).toHaveLength(2);
    expect(ctx.catalog.plans().find((p) => p.id === original.id)).toEqual(
      original,
    );
    const edited = ctx.catalog.plans().find((p) => p.id === copied.id)!;
    expect(edited.sides[0]?.tracks).toHaveLength(0);
    expect(edited.sides[1]?.tracks).toHaveLength(1);
    expect(ctx.catalog.tracks()).toHaveLength(1);
  } finally {
    await ctx.app.close();
  }
});
