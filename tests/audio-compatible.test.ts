import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createApp } from "../src/server/app";
import { ffmpeg } from "../src/server/tools";
import { compatibleWav } from "../src/server/audio";

it("un archivo MP2 con extensión mp3 se sirve como WAV válido sin tocar ni copiar el original", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-compatible-"));
  const ctx = await createApp({ dataDir: dir, watch: false });
  try {
    const root = ctx.catalog.root();
    const file = path.join(root.path, "MP2 disfrazado.mp3");
    await promisify(execFile)(ffmpeg, [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=44100:cl=stereo",
      "-t",
      "0.2",
      "-c:a",
      "mp2",
      "-f",
      "mp2",
      file,
    ]);
    const before = await readFile(file);
    const files = await readdir(root.path);
    const sourceId = await ctx.library.indexFile(
      file,
      root.id,
      path.basename(file),
    );
    const source = ctx.catalog.source(sourceId)!;
    const r = await ctx.app.inject({
      method: "POST",
      url: "/api/audio/compatible",
      headers: { "x-cassettes-client": "local" },
      payload: { sourceId, revision: source.revision },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.rawPayload.subarray(0, 4).toString()).toBe("RIFF");
    expect(r.rawPayload.subarray(8, 12).toString()).toBe("WAVE");
    expect(r.rawPayload.readUInt32LE(40)).toBe(r.rawPayload.length - 44);
    expect(r.rawPayload.readUInt32LE(24)).toBe(44100);
    expect(await readFile(file)).toEqual(before);
    expect(await readdir(root.path)).toEqual(files);
    const stale = await ctx.app.inject({
      method: "POST",
      url: "/api/audio/compatible",
      headers: { "x-cassettes-client": "local" },
      payload: { sourceId, revision: "otra-revision" },
    });
    expect(stale.statusCode).toBe(400);
    await expect(
      compatibleWav(file, new AbortController().signal, 4),
    ).rejects.toThrow("límite");
  } finally {
    await ctx.app.close();
  }
});
it("no convierte audio ilegible ni trabajos cancelados", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cassettes-corrupt-"));
  const file = path.join(dir, "corrupto.mp3");
  await writeFile(file, "no es audio");
  await expect(
    compatibleWav(file, new AbortController().signal),
  ).rejects.toThrow("recuperable");
  const c = new AbortController();
  c.abort();
  await expect(compatibleWav(file, c.signal)).rejects.toThrow();
});
