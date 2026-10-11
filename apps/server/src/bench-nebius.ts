/**
 * Live latency benchmark for the Nemotron tiers Vizli uses on Nebius Token Factory.
 * Makes real, billable calls through the same code paths as the app:
 * fast tier (intent router), core tier (visual-action interpreter) and
 * reasoning tier (lesson author). Run `pnpm bench:nebius`; results are written to
 * stdout as a Markdown table and to .data/verification/nebius-bench.json (ignored).
 */
import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { createDemoProject } from "@vizli/shared";
import { readProviderConfig } from "./config.js";
import { createIntentRouter } from "./intent.js";
import { createLessonAuthor } from "./lessons.js";
import { createNebiusResolver } from "./resolver.js";
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
const provider = readProviderConfig(process.env);
if (!provider.nebiusKey || !provider.tiers) {
  console.error("Set NEBIUS_API_KEY and NEBIUS_MODEL in the repository-root .env first.");
  process.exit(1);
}
const project = createDemoProject();
const slide = project.scenes[0]!;
const whiteboard = project.scenes.find((scene) => scene.layout === "whiteboard") ?? project.scenes[project.scenes.length - 1]!;
const base = { key: provider.nebiusKey, baseUrl: provider.baseUrl };
const runs = Number(process.env.BENCH_RUNS ?? 4);
const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))] ?? 0;
};
type Sample = { tier: string; model: string; cue: string; latencyMs: number; ok: boolean; outcome: string };
const samples: Sample[] = [];
async function measure(tier: string, model: string, cue: string, run: () => Promise<string>) {
  const started = Date.now();
  try {
    const outcome = await run();
    samples.push({ tier, model, cue, latencyMs: Date.now() - started, ok: true, outcome });
  } catch (error) {
    samples.push({ tier, model, cue, latencyMs: Date.now() - started, ok: false, outcome: error instanceof Error ? error.message.slice(0, 80) : "failed" });
  }
}
const router = createIntentRouter({ ...base, model: provider.tiers.fast, timeoutMs: 8000 });
const core = createNebiusResolver({ ...base, model: provider.tiers.core });
const author = createLessonAuthor({ ...base, model: provider.tiers.reasoning, timeoutMs: 60000 });
const routerCues = [
  "Point to revenue",
  "Highlight the second row of matrix A in blue",
  "Today we'll learn about matrix multiplication",
  "Maybe we could add a cache later",
  "Explain how DNS resolution works",
];
const coreCues = [
  "Draw attention to the number that grew the most",
  "Show the channel that brought the most customers",
  "Change revenue to four point five million",
  "Which metric should we celebrate here",
];
const lessonPrompts = [
  "Explain how DNS resolution works",
  "Walk through how a request moves through a load balancer",
];
console.error(`Benchmarking ${runs} run(s) per cue against ${provider.baseUrl} (billable).`);
for (let i = 0; i < runs; i++) {
  for (const cue of routerCues)
    await measure("fast", provider.tiers.fast, cue, async () => {
      const decision = await router({ text: cue, scene: slide });
      if (!decision) throw new Error("router returned no decision");
      return decision.intent;
    });
  for (const cue of coreCues)
    await measure("core", provider.tiers.core, cue, async () => {
      const proposal = await core({ text: cue, scene: slide, cues: project.cues, signal: new AbortController().signal, final: true });
      return `${proposal.type}${proposal.targetId ? `:${proposal.targetId}` : ""}`;
    });
  for (const prompt of lessonPrompts)
    await measure("reasoning", provider.tiers.reasoning, prompt, async () => {
      const lesson = await author({ prompt, scene: whiteboard });
      return lesson.type === "sequence" ? `${lesson.sequence.steps.length} steps` : `skip: ${lesson.reason.slice(0, 40)}`;
    });
}
const tiers = ["fast", "core", "reasoning"] as const;
const rows = tiers.map((tier) => {
  const mine = samples.filter((sample) => sample.tier === tier);
  const ok = mine.filter((sample) => sample.ok).map((sample) => sample.latencyMs);
  return {
    tier,
    model: provider.tiers![tier],
    calls: mine.length,
    failures: mine.length - ok.length,
    p50: quantile(ok, 0.5),
    p95: quantile(ok, 0.95),
    max: Math.max(0, ...ok),
  };
});
const date = new Date().toISOString().slice(0, 10);
const table = [
  `| Tier | Model | Calls | Failures | p50 | p95 | Max |`,
  `| --- | --- | --- | --- | --- | --- | --- |`,
  ...rows.map((row) => `| ${row.tier} | \`${row.model}\` | ${row.calls} | ${row.failures} | ${(row.p50 / 1000).toFixed(2)} s | ${(row.p95 / 1000).toFixed(2)} s | ${(row.max / 1000).toFixed(2)} s |`),
].join("\n");
console.log(`Nebius Token Factory latency, ${date}, ${runs} run(s) per cue, measured from this machine:\n\n${table}\n`);
for (const sample of samples)
  console.log(`- ${sample.tier} · ${sample.ok ? "ok" : "FAILED"} · ${(sample.latencyMs / 1000).toFixed(2)} s · “${sample.cue}” → ${sample.outcome}`);
const outDir = fileURLToPath(new URL("../../../.data/verification/", import.meta.url));
await mkdir(outDir, { recursive: true });
await writeFile(`${outDir}nebius-bench.json`, JSON.stringify({ date, baseUrl: provider.baseUrl, runs, rows, samples }, null, 2));
console.error(`Wrote ${outDir}nebius-bench.json`);
