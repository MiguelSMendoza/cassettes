import { existsSync } from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { z } from "zod";
const require = createRequire(import.meta.url);
const ffmpegModule: unknown = require("ffmpeg-static");
const ffprobeModule: unknown = require("ffprobe-static");
export const ffmpeg =
  process.env.FFMPEG_PATH ||
  (typeof ffmpegModule === "string" ? ffmpegModule : "");
export const ffprobe =
  process.env.FFPROBE_PATH ||
  z.object({ path: z.string() }).parse(ffprobeModule).path;
export const python = path.resolve(
  ".tools/python",
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
export const downloader = process.env.YT_DLP_PATH || python;
export const hasDownloader = () => existsSync(downloader);
export function runYt(
  args: string[],
  options: {
    signal?: AbortSignal;
    onLine?: (line: string) => void;
    timeoutMs?: number;
  } = {},
): Promise<string> {
  if (!hasDownloader())
    return Promise.reject(
      new Error(
        "Falta yt-dlp. Ejecuta npm run setup:audio en la carpeta del proyecto.",
      ),
    );
  return new Promise((resolve, reject) => {
    const prefix = process.env.YT_DLP_PATH ? [] : ["-m", "yt_dlp"];
    const child = spawn(
      downloader,
      [
        ...prefix,
        "--ignore-config",
        "--no-cookies",
        "--js-runtimes",
        "node",
        "--no-warnings",
        ...args,
      ],
      {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        signal: options.signal,
      },
    );
    let stdout = "",
      stderr = "",
      lineBuffer = "";
    const timer = setTimeout(
      () => child.kill("SIGTERM"),
      options.timeoutMs ?? 120000,
    );
    child.stdout.on("data", (b: Buffer) => {
      const text = b.toString();
      stdout += text;
      if (stdout.length > 12_000_000) child.kill("SIGTERM");
      lineBuffer += text;
      const lines = lineBuffer.split(/[\r\n]/);
      lineBuffer = lines.pop() ?? "";
      for (const line of lines) options.onLine?.(line);
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-8000);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            options.signal?.aborted
              ? "Descarga cancelada."
              : stderr.replace(/\u001b\[[0-9;]*m/g, "").slice(-1500) ||
                  "El enlace no pudo procesarse. Puede requerir sesión o no estar disponible.",
          ),
        );
    });
  });
}
