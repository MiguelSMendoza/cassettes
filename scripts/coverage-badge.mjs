import { readFile, writeFile, mkdir } from "node:fs/promises";

const report = JSON.parse(
  await readFile("coverage/coverage-summary.json", "utf8"),
);
const percent = report.total?.lines?.pct;
if (!Number.isFinite(percent) || percent < 0 || percent > 100)
  throw new Error("Informe inválido. Ejecuta primero npm run test:coverage.");
const value = `${percent.toFixed(1)}%`;
const color = percent >= 80 ? "#4c1" : percent >= 50 ? "#dfb317" : "#e05d44";
const date = new Date().toISOString();
await mkdir("badges", { recursive: true });
await writeFile(
  "badges/coverage.svg",
  `<svg xmlns="http://www.w3.org/2000/svg" width="196" height="20" role="img" aria-label="Cobertura local de líneas: ${value}"><title>Cobertura local de líneas: ${value} · ${date}</title><rect width="140" height="20" fill="#555"/><rect x="140" width="56" height="20" fill="${color}"/><g fill="#fff" font-family="Verdana,Arial,sans-serif" font-size="11" text-anchor="middle"><text x="70" y="14">cobertura local · líneas</text><text x="168" y="14">${value}</text></g></svg>\n`,
);
await writeFile(
  "badges/coverage.json",
  JSON.stringify(
    { generatedAt: date, scope: "src/**/*.{ts,tsx}", metrics: report.total },
    null,
    2,
  ) + "\n",
);
console.log(
  `Cobertura local de líneas: ${value}. Badge e instantánea actualizados.`,
);
