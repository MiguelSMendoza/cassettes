import { spawn } from "node:child_process";
import { ffmpeg } from "./tools";

/** WAV PCM compatible, únicamente en RAM. Nunca escribe ni modifica el original. */
export async function compatibleWav(
  file: string,
  signal: AbortSignal,
  maxBytes = 256 * 1024 * 1024,
) {
  signal.throwIfAborted();
  return new Promise<{ wav: Buffer; warnings: boolean }>((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        "-nostdin",
        "-v",
        "error",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
      ],
      { shell: false, stdio: ["ignore", "pipe", "pipe"], signal },
    );
    const chunks: Buffer[] = [];
    let bytes = 0,
      stderr = "",
      failure: Error | null = null;
    const timer = setTimeout(() => {
      failure = new Error("El audio tardó demasiado en decodificarse.");
      child.kill("SIGTERM");
    }, 90000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = new Error(
          "El audio supera el límite de 256 MB decodificados por canción.",
        );
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      if (failure) {
        reject(failure);
        return;
      }
      if (code !== 0 || !bytes || bytes % 4 !== 0) {
        reject(
          new Error(
            "El archivo no contiene audio recuperable. Revisa el original.",
          ),
        );
        return;
      }
      const wav = Buffer.allocUnsafe(44 + bytes);
      wav.write("RIFF", 0);
      wav.writeUInt32LE(36 + bytes, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(2, 22);
      wav.writeUInt32LE(44100, 24);
      wav.writeUInt32LE(44100 * 4, 28);
      wav.writeUInt16LE(4, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(bytes, 40);
      let offset = 44;
      for (const chunk of chunks) {
        chunk.copy(wav, offset);
        offset += chunk.length;
      }
      resolve({ wav, warnings: !!stderr.trim() });
    });
  });
}
