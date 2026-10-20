/** Mismo audio y duración para planificación y grabación, con fallback local. */
export async function decodeLocalAudio(
  context: Pick<BaseAudioContext, "decodeAudioData">,
  sourceId: string,
  title: string,
  revision: string,
  signal?: AbortSignal,
  recovered?: (warnings: boolean) => void,
): Promise<AudioBuffer> {
  signal?.throwIfAborted();
  const response = await fetch(`/api/audio/${encodeURIComponent(sourceId)}`, {
    signal,
  });
  if (!response.ok)
    throw new Error(
      `No está disponible «${title}». Revisa su ubicación y actualiza la biblioteca.`,
    );
  const original = await response.arrayBuffer();
  signal?.throwIfAborted();
  try {
    const buffer = await context.decodeAudioData(original);
    signal?.throwIfAborted();
    return buffer;
  } catch {
    signal?.throwIfAborted();
    try {
      const compatible = await fetch("/api/audio/compatible", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Cassettes-Client": "local",
        },
        body: JSON.stringify({ sourceId, revision }),
        signal,
      });
      if (!compatible.ok) {
        const detail: unknown = await compatible.json().catch(() => null);
        throw new Error(
          typeof detail === "object" && detail !== null && "error" in detail
            ? String(detail.error)
            : "No se pudo obtener audio compatible.",
        );
      }
      const buffer = await context.decodeAudioData(
        await compatible.arrayBuffer(),
      );
      signal?.throwIfAborted();
      recovered?.(compatible.headers.get("X-Cassettes-Audio-Warnings") === "1");
      return buffer;
    } catch (e) {
      signal?.throwIfAborted();
      throw new Error(
        `No se pudo decodificar «${title}»: ${e instanceof Error ? e.message : "audio ilegible"}.`,
      );
    }
  }
}
