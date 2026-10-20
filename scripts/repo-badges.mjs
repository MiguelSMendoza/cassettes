import { readFile, writeFile } from "node:fs/promises";

const [repository, ...flags] = process.argv.slice(2);
if (
  !repository ||
  !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
  flags.some((f) => f !== "--qlty")
)
  throw new Error(
    "Uso: npm run repo:badges -- propietario/repositorio [--qlty]",
  );
const base = `https://github.com/${repository}`;
const badges = [
  `[![CI](${base}/actions/workflows/ci.yml/badge.svg?branch=main)](${base}/actions/workflows/ci.yml)`,
  `[![Issues abiertas](https://img.shields.io/github/issues/${repository})](${base}/issues)`,
];
if (flags.includes("--qlty")) {
  badges.push(
    `[![Mantenibilidad](https://qlty.sh/gh/${repository.replace("/", "/projects/")}/maintainability.svg)](https://qlty.sh/gh/${repository.replace("/", "/projects/")})`,
  );
  badges.push(
    `[![Cobertura Qlty](https://qlty.sh/gh/${repository.replace("/", "/projects/")}/coverage.svg)](https://qlty.sh/gh/${repository.replace("/", "/projects/")})`,
  );
}
const path = "README.md",
  original = await readFile(path, "utf8");
const marker = /<!-- github-badges:start -->[\s\S]*?<!-- github-badges:end -->/;
if (!marker.test(original))
  throw new Error("No se encuentra el bloque de badges del README.");
await writeFile(
  path,
  original.replace(
    marker,
    `<!-- github-badges:start -->\n${badges.join("\n")}\n<!-- github-badges:end -->`,
  ),
);
console.log(
  "Badges configurados. CI e issues necesitan el repositorio publicado; Qlty requiere vincular el servicio.",
);
