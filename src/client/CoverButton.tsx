import { useState } from "react";
import { Printer, LoaderCircle } from "lucide-react";
import type { Plan } from "../domain/types";
let fontPromise: Promise<string> | null = null;
function loadFont() {
  if (!fontPromise)
    fontPromise = (async () => {
      const response = await fetch(
        new URL("../assets/fonts/NotoSans-Regular.ttf", import.meta.url),
      );
      if (!response.ok)
        throw new Error(
          "No se pudo cargar la tipografía de la carátula. Vuelve a intentarlo.",
        );
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return btoa(binary);
    })().catch((e: unknown) => {
      fontPromise = null;
      throw e;
    });
  return fontPromise;
}
export function CoverButton({ plan }: { plan: Plan }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="cover-export">
      <button
        className="secondary"
        disabled={busy || !plan.sides.some((s) => s.tracks.length)}
        onClick={() => {
          const snapshot = structuredClone(plan);
          setBusy(true);
          setMessage("");
          setError("");
          void (async () => {
            try {
              const [{ createCoverPdf }, font] = await Promise.all([
                import("../printing/cover"),
                loadFont(),
              ]);
              const { pdf, unsupportedCharacters } = createCoverPdf(
                snapshot,
                font,
              );
              const name = (snapshot.name.trim() || "Mi cinta")
                .replace(/[^\p{L}\p{N} ._-]/gu, "_")
                .slice(0, 100);
              await pdf.save(`${name} - caratulas.pdf`, {
                returnPromise: true,
              });
              setMessage(
                `PDF descargado con carátula y etiquetas A/B de 70 × 10 mm por casete. Imprime en A4 al 100 %, sin ajustar a página.${unsupportedCharacters.length ? ` La tipografía no admite estos símbolos y se sustituyeron por ?: ${unsupportedCharacters.join(" ")}.` : ""}`,
              );
            } catch (e) {
              setError(
                e instanceof Error
                  ? e.message
                  : "No se pudo generar la carátula.",
              );
            } finally {
              setBusy(false);
            }
          })();
        }}
      >
        {busy ? (
          <LoaderCircle className="spin" size={16} />
        ) : (
          <Printer size={16} />
        )}{" "}
        {busy ? "Creando PDF…" : "Carátula PDF"}
      </button>
      {message && (
        <p className="help cover-message" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="error-text cover-message" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
