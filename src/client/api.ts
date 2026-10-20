export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const r = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined
        ? {}
        : { "Content-Type": "application/json", "X-Cassettes-Client": "local" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data: unknown = await r.json();
  if (!r.ok)
    throw new Error(
      typeof data === "object" && data !== null && "error" in data
        ? String(data.error)
        : "La operación no pudo completarse.",
    );
  return data as T;
}
