import WebSocket from "ws";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  UsageGuard,
  VoiceBudget,
  limitsFromEnv,
  type UsageLimits,
} from "./usage.js";
import { createNebiusResolver } from "./resolver.js";
import { generateScene } from "./generate.js";
import { createDemoProject } from "@vizli/shared";
import { NvidiaSpeech } from "./speech.js";
import { buildApp } from "./app.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "vizli-usage-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
/** Session messages other than `join` require a joined project room; the microphone needs an editor's token. */
async function joinEditable(app: Awaited<ReturnType<typeof buildApp>>, socket: WebSocket) {
  const created = await app.inject({ method: "POST", url: "/api/projects", payload: { template: "demo" } });
  const { id, editToken } = created.json() as { id: string; editToken: string };
  const joined = new Promise<void>((resolve) => {
    const handler = (data: Buffer, isBinary: boolean) => {
      if (isBinary || JSON.parse(data.toString()).type !== "joined") return;
      socket.off("message", handler);
      resolve();
    };
    socket.on("message", handler);
  });
  socket.send(
    JSON.stringify({ type: "join", projectId: id, token: editToken, userId: "user-1", clientId: "client-1", name: "Tester", color: "#d2432f" }),
  );
  await joined;
}
const limits: UsageLimits = {
  voiceConcurrent: 1,
  voiceSeconds: 10,
  llmHourly: 2,
  llmConcurrent: 1,
  llmHourlyPerClient: 2,
  llmConcurrentPerClient: 1,
  voiceConcurrentPerClient: 1,
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("in-process usage limits", () => {
  it("loads bounded request/concurrency defaults without provider changes", () => {
    expect(limitsFromEnv({})).toEqual({
      voiceConcurrent: 5,
      voiceSeconds: 600,
      llmHourly: 1200,
      llmConcurrent: 3,
      llmHourlyPerClient: 120,
      llmConcurrentPerClient: 2,
      voiceConcurrentPerClient: 2,
    });
    expect(
      limitsFromEnv({ MAX_CONCURRENT_LLM_REQUESTS: "0" }).llmConcurrent,
    ).toBe(0);
  });
  it("shares an hourly rolling request budget and releases concurrency idempotently", () => {
    let now = 0;
    const guard = new UsageGuard(limits, () => now),
      release = guard.acquireLLM();
    expect(() => guard.acquireLLM()).toThrow("busy");
    release();
    release();
    guard.acquireLLM()();
    expect(guard.snapshot()).toMatchObject({ voice: 0, llm: 0, attempts: 2 });
    expect(() => guard.acquireLLM()).toThrow("hourly");
    now = 3600000;
    guard.acquireLLM()();
    expect(guard.snapshot().attempts).toBe(1);
  });
  it("caps each client before the shared budget so one visitor cannot drain it", () => {
    let now = 0;
    const guard = new UsageGuard({ ...limits, llmHourly: 3, llmHourlyPerClient: 1, voiceConcurrent: 2, voiceConcurrentPerClient: 1 }, () => now);
    const a = guard.forClient("10.0.0.1"), b = guard.forClient("10.0.0.2");
    a.acquireLLM()();
    expect(() => a.acquireLLM()).toThrow("Your hourly");
    b.acquireLLM()();
    guard.forClient("10.0.0.3").acquireLLM()();
    // The shared budget is exhausted by three different clients; a fourth is told about the server limit.
    expect(() => guard.forClient("10.0.0.4").acquireLLM()).toThrow("server’s hourly");
    expect(guard.snapshot()).toMatchObject({ attempts: 3, clients: 4 });
    now = 3_600_001;
    a.acquireLLM()();
    const voiceA = a.acquireVoice();
    expect(() => a.acquireVoice()).toThrow("maximum number of microphones");
    const voiceB = b.acquireVoice();
    expect(() => guard.forClient("10.0.0.3").acquireVoice()).toThrow("All voice");
    voiceA();
    voiceA();
    voiceB();
    expect(guard.snapshot().voice).toBe(0);
    // Concurrency per client: one in flight blocks the same client but not another.
    const roomy = new UsageGuard({ ...limits, llmHourly: 10, llmHourlyPerClient: 10, llmConcurrent: 2, llmConcurrentPerClient: 1 });
    const inFlight = roomy.forClient("10.0.0.9").acquireLLM();
    expect(() => roomy.forClient("10.0.0.9").acquireLLM()).toThrow("in progress");
    roomy.forClient("10.0.0.8").acquireLLM()();
    inFlight();
  });
  it("counts failed model attempts and releases both cue and planning capacity", async () => {
    const guard = new UsageGuard(limits);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Provider failed")),
    );
    const resolver = createNebiusResolver({
      key: "test",
      model: "test",
      baseUrl: "https://example.test/v1",
      usage: guard,
    });
    await expect(
      resolver({
        text: "revenue",
        scene: createDemoProject().scenes[0]!,
        cues: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Provider failed");
    expect(guard.snapshot()).toMatchObject({ llm: 0, attempts: 1 });
    await expect(
      generateScene(
        { prompt: "a story", kind: "slide" },
        { NEBIUS_API_KEY: "test", NEBIUS_MODEL: "test" },
        guard,
      ),
    ).rejects.toThrow("Provider failed");
    expect(guard.snapshot()).toMatchObject({ llm: 0, attempts: 2 });
    await expect(
      resolver({
        text: "revenue",
        scene: createDemoProject().scenes[0]!,
        cues: [],
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("hourly");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("preserves voice allowance over toggles and releases its slot at expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const guard = new UsageGuard(limits),
      budget = new VoiceBudget(guard),
      expired = vi.fn();
    budget.start(expired);
    expect(() => new VoiceBudget(guard).start(() => {})).toThrow("All voice");
    await vi.advanceTimersByTimeAsync(4000);
    budget.stop();
    expect(guard.snapshot().voice).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    budget.start(expired);
    await vi.advanceTimersByTimeAsync(5999);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expired).toHaveBeenCalledOnce();
    expect(guard.snapshot().voice).toBe(0);
    expect(() => budget.start(expired)).toThrow("allowance");
  });
  it("allows real-time PCM with a short burst but rejects faster upload", () => {
    let now = 0;
    const budget = new VoiceBudget(new UsageGuard(limits, () => now));
    budget.start(() => {});
    try {
      expect(budget.audio(32000)).toBe(true);
      expect(budget.audio(32000)).toBe(true);
      expect(() => budget.audio(32000)).toThrow("too quickly");
      now = 1000;
      expect(budget.audio(32000)).toBe(true);
      budget.stop();
      budget.start(() => {});
      expect(() => budget.audio(32000)).toThrow("too quickly");
    } finally {
      budget.stop();
    }
  });
  it("stops upstream transport and releases voice slots after provider failure and disconnect", async () => {
    const guard = new UsageGuard(limits),
      connections: {
        close: ReturnType<typeof vi.fn>;
        audio: ReturnType<typeof vi.fn>;
        callbacks: ConstructorParameters<typeof NvidiaSpeech>[2];
      }[] = [];
    const app = await buildApp(
      { NODE_ENV: "test", NVIDIA_API_KEY: "test", DATA_DIR: await tempDir() },
      {
        usage: guard,
        createSpeech: (_key, _model, callbacks) => {
          const connection = { close: vi.fn(), audio: vi.fn(), callbacks };
          connections.push(connection);
          return connection;
        },
      },
    );
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const socket = new WebSocket(
      address.replace("http://", "ws://") + "/api/session",
    );
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    try {
      await joinEditable(app, socket);
      socket.send(JSON.stringify({ type: "listen", enabled: true }));
      await vi.waitFor(() => expect(connections).toHaveLength(1));
      expect(guard.snapshot().voice).toBe(1);
      connections[0]!.callbacks.state("error");
      expect(connections[0]!.close).toHaveBeenCalledOnce();
      expect(guard.snapshot().voice).toBe(0);
      socket.send(JSON.stringify({ type: "listen", enabled: true }));
      await vi.waitFor(() => expect(connections).toHaveLength(2));
      socket.close();
      await vi.waitFor(() => expect(guard.snapshot().voice).toBe(0));
      expect(connections[1]!.close).toHaveBeenCalledOnce();
    } finally {
      socket.close();
      await app.close();
    }
  });
  it("releases active upstream voice on server shutdown", async () => {
    const guard = new UsageGuard(limits),
      close = vi.fn();
    const app = await buildApp(
      { NODE_ENV: "test", NVIDIA_API_KEY: "test", DATA_DIR: await tempDir() },
      { usage: guard, createSpeech: () => ({ audio: vi.fn(), close }) },
    );
    await app.ready();
    const socket = await app.injectWS("/api/session");
    await joinEditable(app, socket);
    socket.send(JSON.stringify({ type: "listen", enabled: true }));
    await vi.waitFor(() => expect(guard.snapshot().voice).toBe(1));
    await app.close();
    expect(close).toHaveBeenCalledOnce();
    expect(guard.snapshot().voice).toBe(0);
    socket.close();
  });
  it("returns an honest HTTP429 without calling a paid provider when capped", async () => {
    const app = await buildApp(
      { NODE_ENV: "test", NEBIUS_API_KEY: "test", NEBIUS_MODEL: "test" },
      { usage: new UsageGuard({ ...limits, llmHourly: 0 }) },
    );
    vi.stubGlobal("fetch", vi.fn());
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/scenes/generate",
        payload: { prompt: "An idea", kind: "slide" },
      });
      expect(response.statusCode).toBe(429);
      expect(response.json().error).toContain("hourly");
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
