// Deliberately bypass src/index.ts: it loads the developer's private .env.
import { buildApp } from '../apps/server/src/app.js';
const app = await buildApp();
await app.listen({ port: 3002, host: '127.0.0.1' });
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => { void app.close().then(() => process.exit(0)); });
