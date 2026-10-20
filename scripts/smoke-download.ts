import { createApp } from "../src/server/app";
const ctx = await createApp({ dataDir: ".data/qa-download", watch: false });
try {
  const jobs = await ctx.downloads.enqueue([
    process.argv[2] ?? "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
  ]);
  const id = jobs[0]!.id;
  let last = "";
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const j = ctx.catalog.jobs().find((j) => j.id === id)!;
    if (j.status !== last) {
      console.log(j.status, j.progress);
      last = j.status;
    }
    if (["completed", "failed", "cancelled"].includes(j.status)) {
      console.log(
        JSON.stringify(
          {
            status: j.status,
            error: j.error,
            sourceId: j.sourceId,
            tracks: ctx.catalog.tracks().length,
          },
          null,
          2,
        ),
      );
      if (j.status !== "completed") process.exitCode = 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
} finally {
  if (
    ctx.catalog.jobs().some((j) => ["running", "queued"].includes(j.status))
  ) {
    console.error("Descarga sin terminar dentro del plazo de comprobación.");
    process.exitCode = 1;
  }
  await ctx.downloads.close();
  await ctx.app.close();
}
