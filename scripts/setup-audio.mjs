import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const base = path.resolve(".tools/python");
mkdirSync(".tools", { recursive: true });
function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(base)) run("python3", ["-m", "venv", base]);
const python = path.join(
  base,
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
run(python, ["-m", "pip", "install", "-r", "requirements-audio.lock"]);
const freeze = spawnSync(python, ["-m", "pip", "freeze"], { encoding: "utf8" });
if (freeze.status === 0)
  writeFileSync(".tools/requirements.lock", freeze.stdout);
run(python, ["-m", "yt_dlp", "--version"]);
console.log(
  "Herramientas listas. FFmpeg y ffprobe se incluyen en las dependencias npm.",
);
