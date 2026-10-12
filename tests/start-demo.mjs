// Isolated E2E servers: no .env loading, provider spend, or user project writes.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const data = await mkdtemp(join(tmpdir(), 'vizli-e2e-'));
// Every browser in the suite connects from 127.0.0.1, so the per-client caps (meant for one visitor) are raised here.
const env = { ...process.env, DATA_DIR: data, HOST: '127.0.0.1', PORT: '3002', ALLOWED_ORIGINS: 'http://127.0.0.1:5174', NEBIUS_API_KEY: '', NVIDIA_API_KEY: '', VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '', MAX_PROJECTS_CREATED_PER_HOUR_PER_CLIENT: '10000', MAX_PROJECTS_CREATED_PER_HOUR: '10000', MAX_SOCKETS_PER_CLIENT: '500' };
const serverRequire=createRequire(join(root,'apps/server/package.json'));
const webRequire=createRequire(join(root,'apps/web/package.json'));
const children = [
  spawn(process.execPath, [serverRequire.resolve('tsx/cli'), join(root,'tests/demo-server.mts')], { cwd: root, env, stdio: 'inherit', detached: true }),
  spawn(process.execPath, [join(dirname(webRequire.resolve('vite/package.json')),'bin/vite.js'), '--config', join(root,'tests/vite.config.ts'), '--host', '127.0.0.1'], { cwd: join(root,'apps/web'), env, stdio: 'inherit', detached: true }),
];
let stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  await Promise.all(children.map(child => (child.exitCode !== null || child.signalCode !== null) ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
  await rm(data, { recursive: true, force: true });
  process.exit(code);
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => void stop());
for (const child of children) child.on('exit', code => { if (!stopping) void stop(code ?? 1); });
