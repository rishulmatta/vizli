import { config } from "dotenv";
import { resolve } from "node:path";
import { buildApp, repoRoot } from "./app.js";
config({ path: resolve(repoRoot, ".env") });
const app = await buildApp();
const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
try {
  await app.listen({ port, host });
} catch (error) {
  if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
    app.log.error(
      `Port ${port} on ${host} is already in use by another process. ` +
        "Stop that process or set PORT in the repository-root .env; the Vite proxy follows the same PORT.",
    );
    process.exit(1);
  }
  throw error;
}
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    void app.close().then(() => process.exit(0));
  });
