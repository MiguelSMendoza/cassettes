import "dotenv/config";
import { createApp } from "./app";
const port = Number(process.env.PORT ?? 4310);
const { app } = await createApp({ port });
await app.listen({ host: "127.0.0.1", port });
console.log(`\n Cassettes · http://127.0.0.1:${port}\n`);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
