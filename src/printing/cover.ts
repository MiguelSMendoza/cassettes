import { jsPDF } from "jspdf";
import type { Plan } from "../domain/types";
import { displayTime } from "../domain/types";

export const coverGeometry = {
  width: 102,
  height: 94,
  folds: [66, 77],
  x: 54,
  y: 50,
} as const;
const mmPerPoint = 25.4 / 72;

/** PDF vectorial en A4: las medidas de corte y pliegue nunca dependen del texto. */
export function createCoverPdf(plan: Plan, fontBase64: string) {
  const tapes = [
    ...new Set(plan.sides.filter((s) => s.tracks.length).map((s) => s.tape)),
  ].sort((a, b) => a - b);
  if (!tapes.length)
    throw new Error("La cinta no contiene canciones para imprimir.");
  const pdf = new jsPDF({
    unit: "mm",
    format: "a4",
    compress: true,
    putOnlyUsedFonts: true,
    floatPrecision: 6,
  });
  pdf.addFileToVFS("NotoSans.ttf", fontBase64);
  pdf.addFont("NotoSans.ttf", "NotoSans", "normal");
  pdf.setFont("NotoSans");
  pdf.setProperties({
    title: `Carátulas - ${plan.name}`,
    subject:
      "Carátula de casete 102 x 94 mm; pliegues a 66 y 77 mm; etiquetas A/B de 70 x 10 mm",
    creator: "Cassettes",
  });
  const unsupported = new Set<string>();
  const metadata: unknown = pdf.getFont().metadata;
  const glyph =
    typeof metadata === "object" &&
    metadata !== null &&
    "characterToGlyph" in metadata &&
    typeof metadata.characterToGlyph === "function"
      ? (metadata.characterToGlyph.bind(metadata) as (code: number) => number)
      : null;
  function clean(value: string) {
    return [...value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/g, " ")]
      .map((c) => {
        if (glyph && c !== " " && !glyph(c.codePointAt(0)!)) {
          unsupported.add(c);
          return "?";
        }
        return c;
      })
      .join("");
  }
  function text(
    value: string,
    x: number,
    y: number,
    size: number,
    align: "left" | "right" | "center" = "left",
  ) {
    pdf.setFontSize(size);
    pdf.text(clean(value), x, y, { align });
  }
  // Girar cada panel alrededor de su propio centro conserva sus márgenes
  // y permite leerlo correctamente después de doblar la carátula.
  function invertedText(
    value: string,
    px: number,
    py: number,
    size: number,
    top: number,
    bottom: number,
    align: "left" | "right" = "left",
  ) {
    pdf.setFontSize(size);
    const originalLeft =
      align === "right" ? px - pdf.getTextWidth(clean(value)) : px;
    pdf.text(
      clean(value),
      2 * coverGeometry.x + coverGeometry.width - originalLeft,
      2 * coverGeometry.y + top + bottom - py,
      { angle: 180 },
    );
  }
  function fit(value: string, width: number, size: number, min: number) {
    pdf.setFontSize(size);
    while (pdf.getTextWidth(clean(value)) > width && size > min) {
      size -= 0.25;
      pdf.setFontSize(size);
    }
    let result = clean(value);
    while (pdf.getTextWidth(result) > width && result.length)
      result = result.slice(0, -1);
    if (result !== clean(value)) {
      while (pdf.getTextWidth(result + "...") > width && result.length)
        result = result.slice(0, -1);
      result += "...";
    }
    return { value: result, size, shortened: result !== clean(value) };
  }
  const includedTrackIds: string[] = [];
  const { x, y, width, height, folds } = coverGeometry;
  function guidePage(tape: number) {
    pdf.setTextColor(40);
    text("CARÁTULA DE CASETE", x, 23, 12);
    text(`Cinta ${tape} · ${width} x ${height} mm`, x, 30, 8);
    text(
      "Imprimir en A4, tamaño real / escala 100 %. Desactivar «ajustar a página».",
      x,
      36,
      7.5,
    );
    pdf.setDrawColor(120);
    pdf.setLineWidth(0.15);
    pdf.rect(x, y, width, height);
    // Marcas de corte fuera del papel útil.
    for (const [cx, cy] of [
      [x, y],
      [x + width, y],
      [x, y + height],
      [x + width, y + height],
    ]) {
      pdf.line(cx! - 3, cy!, cx! - 1, cy!);
      pdf.line(cx! + 1, cy!, cx! + 3, cy!);
      pdf.line(cx!, cy! - 3, cx!, cy! - 1);
      pdf.line(cx!, cy! + 1, cx!, cy! + 3);
    }
    pdf.setLineDashPattern([1, 1], 0);
    pdf.setDrawColor(175);
    for (const fold of folds) {
      pdf.line(x, y + fold, x + width, y + fold);
      text(`Pliegue ${fold} mm`, x - 4, y + fold + 0.8, 6, "right");
    }
    pdf.setLineDashPattern([], 0);
    text(
      "Cortar por el borde exterior y doblar por las líneas discontinuas.",
      x,
      y + height + 10,
      7,
    );
    text(
      "Panel principal: 66 mm · Canto: 11 mm · Solapa: 17 mm.",
      x,
      y + height + 15,
      7,
    );
    pdf.setDrawColor(80);
    pdf.setLineWidth(0.2);
    pdf.line(x, y + height + 27, x + 50, y + height + 27);
    for (let tick = 0; tick <= 50; tick += 10)
      pdf.line(x + tick, y + height + 25.5, x + tick, y + height + 28.5);
    text("Esta regla debe medir 50 mm en el papel.", x, y + height + 34, 7);
  }
  for (const [tapeIndex, tape] of tapes.entries()) {
    if (tapeIndex) pdf.addPage();
    guidePage(tape);
    const sides = (["A", "B"] as const).map((face) =>
      plan.sides.find((s) => s.tape === tape && s.face === face),
    );
    const name = plan.name.trim() || "Mi cinta";
    const title = fit(name, 96, 12, 8);
    text("C A S S E T T E S", x + 3, y + 4, 5.5);
    text(title.value, x + 3, y + 10, title.size);
    text(`C${plan.config.profile}  /  Cinta ${tape}`, x + 3, y + 15, 6.5);
    for (const [column, side] of sides.entries()) {
      const cx = x + 2.5 + column * 50;
      text(`CARA ${column === 0 ? "A" : "B"}`, cx, y + 21, 8);
      text(
        side?.tracks.length ? displayTime(side.programMs) : "Vacía",
        cx + 47,
        y + 21,
        6.5,
        "right",
      );
      pdf.setDrawColor(180);
      pdf.setLineWidth(0.15);
      pdf.line(cx, y + 22, cx + 47, y + 22);
      if (!side?.tracks.length) {
        text("Sin canciones", cx, y + 27, 7);
        continue;
      }
      // Una fila por canción. La altura se reparte hasta el pliegue;
      // número y duración conservan su columna, el título se recorta.
      const rowStep = Math.min(3.6, 40 / Math.max(1, side.tracks.length - 1));
      const size = Math.min(8, rowStep / (mmPerPoint * 1.2));
      pdf.setFontSize(size);
      const numberWidth =
        pdf.getTextWidth(String(side.tracks.length).padStart(2, "0")) + 1;
      const durationWidth = Math.max(
        ...side.tracks.map((track) =>
          pdf.getTextWidth(displayTime(track.durationMs)),
        ),
      );
      const titleWidth = 47 - numberWidth - durationWidth - 1;
      for (const [index, track] of side.tracks.entries()) {
        const rowY = y + 24.5 + index * rowStep;
        text(String(index + 1).padStart(2, "0"), cx, rowY, size);
        const title = fit(track.title, titleWidth, size, size);
        text(title.value, cx + numberWidth, rowY, size);
        text(displayTime(track.durationMs), cx + 47, rowY, size, "right");
        includedTrackIds.push(track.id);
      }
    }
    // Canto y solapa girados 180°; el panel principal conserva su orientación.
    const spine = fit(`${name} · ${tape}`, 86, 10, 6);
    invertedText(spine.value, x + 3, y + 72.8, spine.size, 66, 77);
    invertedText(
      `C${plan.config.profile}`,
      x + 98,
      y + 72.8,
      7,
      66,
      77,
      "right",
    );
    // Dos etiquetas recortables por casete, fuera de la carátula y sus guías.
    text("ETIQUETAS PARA LA CINTA · 70 x 10 mm", x, 195, 8);
    const labelTitle = fit(`${name} · ${tape}`, 51, 9, 6);
    for (const [index, face] of ["A", "B"].entries()) {
      const labelX = 70,
        labelY = 204 + index * 16;
      pdf.setDrawColor(120);
      pdf.setLineWidth(0.15);
      pdf.rect(labelX, labelY, 70, 10);
      pdf.line(labelX + 56, labelY, labelX + 56, labelY + 10);
      text(labelTitle.value, labelX + 3, labelY + 6.1, labelTitle.size);
      text(`CARA ${face}`, labelX + 63, labelY + 6.1, 7, "center");
    }
    text("Recortar por el borde de cada etiqueta.", x, 238, 7);
    invertedText("DOS CARAS. UNA BUENA SELECCIÓN.", x + 3, y + 81, 5.5, 77, 94);
    sides.forEach((side, i) => {
      const music = (side?.tracks ?? []).reduce(
        (sum, t) => sum + t.durationMs,
        0,
      );
      invertedText(
        `Cara ${i === 0 ? "A" : "B"} · ${side?.tracks.length ?? 0} canciones · música ${displayTime(music)} · con pausas ${displayTime(side?.programMs ?? 0)}`,
        x + 3,
        y + 85 + i * 4,
        6.5,
        77,
        94,
      );
    });
  }
  return {
    pdf,
    includedTrackIds,
    unsupportedCharacters: [...unsupported],
  };
}
