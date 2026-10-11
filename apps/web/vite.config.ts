import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// The API port follows the server's PORT setting from the repository-root .env
// (or the process environment), so the whole stack can move off 3001 together.
export default defineConfig(({ mode }) => {
  const repoRoot = resolve(import.meta.dirname, "../..");
  const rootEnv = loadEnv(mode, repoRoot, ["PORT", "HOST"]);
  const apiPort = process.env.PORT?.trim() || rootEnv.PORT?.trim() || "3001";
  const apiHost = process.env.HOST?.trim() || rootEnv.HOST?.trim() || "127.0.0.1";
  const apiTarget = `http://${apiHost === "0.0.0.0" || apiHost === "::" ? "127.0.0.1" : apiHost}:${apiPort}`;
  return {
    plugins: [react()],
    server: {
      port: 5173,
      proxy: { "/api": { target: apiTarget, ws: true } },
    },
  };
});
