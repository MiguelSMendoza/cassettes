import { it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { createCoverPdf, coverGeometry } from "../src/printing/cover";
import { buildPlan } from "../src/domain/planner";
import { defaultConfig, type Occurrence } from "../src/domain/types";
const font = readFileSync(
  new URL("../src/assets/fonts/NotoSans-Regular.ttf", import.meta.url),
).toString("base64");
function song(id: number, title = `Canción número ${id}`): Occurrence {
  return {
    id: String(id),
    trackId: String(id),
    sourceId: String(id),
    revision: "r",
    title,
    artist: "",
    kind: "local",
    durationMs: 180000,
  };
}
it("una carátula por casete mantiene ambas caras y medidas físicas exactas", () => {
  const p = buildPlan([song(1), song(2), song(3)], {
    ...defaultConfig,
    mode: "order",
  });
  p.name = "Música de otoño";
  const before = JSON.stringify(p);
  const result = createCoverPdf(p, font);
  expect(result.pdf.getNumberOfPages()).toBe(1);
  expect(coverGeometry).toMatchObject({
    width: 102,
    height: 94,
    folds: [66, 77],
  });
  expect(result.pdf.output()).toMatch(/^%PDF-/);
  expect(JSON.stringify(p)).toBe(before);
});
it("las listas extensas se imprimen completas en una sola hoja, sin anexos", () => {
  const p = buildPlan([song(1)], defaultConfig);
  p.sides[0]!.tracks = Array.from({ length: 65 }, (_, i) =>
    song(
      i,
      `Título largo ${i}: una canción de prueba con nombre completo y duración`,
    ),
  );
  const r = createCoverPdf(p, font);
  expect(r.pdf.getNumberOfPages()).toBe(1);
  expect(r.includedTrackIds).toHaveLength(65);
  expect(new Set(r.includedTrackIds).size).toBe(65);
});
it("varios casetes producen carátulas independientes; las caras vacías se indican", () => {
  const p = buildPlan([song(1)], defaultConfig);
  p.sides.push({ ...p.sides[0]!, id: "2A", tape: 2, tracks: [song(2)] });
  const r = createCoverPdf(p, font);
  expect(r.pdf.getNumberOfPages()).toBe(2);
  expect(r.includedTrackIds).toEqual(["1", "2"]);
});

it("los símbolos sin glifo se avisan explícitamente y no quedan en blanco", () => {
  const p = buildPlan([song(1, "Canción 漢")], defaultConfig);
  expect(createCoverPdf(p, font).unsupportedCharacters).toContain("漢");
});
it("las canciones excluidas del reparto no se imprimen como si estuvieran grabadas", () => {
  const p = buildPlan(
    [song(1), { ...song(2), durationMs: 4000000 }],
    defaultConfig,
  );
  expect(p.excluded).toHaveLength(1);
  expect(createCoverPdf(p, font).includedTrackIds).toEqual(["1"]);
});
