/** Single-process guardrails, not billing accounting or authentication. */
export class UsageLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageLimitError";
  }
}
export type UsageLimits = {
  voiceConcurrent: number;
  voiceSeconds: number;
  llmHourly: number;
  llmConcurrent: number;
  /** Per-client ceilings (one client = one IP address, see TRUST_PROXY) checked before the shared ones. */
  llmHourlyPerClient: number;
  llmConcurrentPerClient: number;
  voiceConcurrentPerClient: number;
};
export const limit = (value: string | undefined, fallback: number) =>
  value !== undefined &&
  /^\d+$/.test(value) &&
  Number.isSafeInteger(Number(value))
    ? Number(value)
    : fallback;
export function limitsFromEnv(env: NodeJS.ProcessEnv): UsageLimits {
  return {
    voiceConcurrent: limit(env.MAX_CONCURRENT_VOICE_SESSIONS, 5),
    voiceSeconds: limit(env.MAX_VOICE_SECONDS_PER_SESSION, 600),
    llmHourly: limit(env.MAX_LLM_REQUESTS_PER_HOUR, 1200),
    llmConcurrent: limit(env.MAX_CONCURRENT_LLM_REQUESTS, 3),
    llmHourlyPerClient: limit(env.MAX_LLM_REQUESTS_PER_HOUR_PER_CLIENT, 120),
    llmConcurrentPerClient: limit(env.MAX_CONCURRENT_LLM_REQUESTS_PER_CLIENT, 2),
    voiceConcurrentPerClient: limit(env.MAX_CONCURRENT_VOICE_SESSIONS_PER_CLIENT, 2),
  };
}
/** What provider adapters and budgets need: the shared guard itself, or a per-client view of it. */
export interface UsageGate {
  readonly limits: UsageLimits;
  now(): number;
  acquireVoice(): () => void;
  acquireLLM(): () => void;
}
const HOUR_MS = 3_600_000;
/** Idle per-client counters are swept once the table grows past this many keys. */
const CLIENT_SWEEP_SIZE = 512;
type ClientCounters = {
  llmAttempts: number[];
  llmActive: number;
  voiceActive: number;
  touched: number;
};
export class UsageGuard implements UsageGate {
  private activeVoice = 0;
  private activeLLM = 0;
  private attempts: number[] = [];
  private readonly clients = new Map<string, ClientCounters>();
  constructor(
    readonly limits: UsageLimits,
    readonly now: () => number = Date.now,
  ) {}
  acquireVoice(): () => void {
    if (this.activeVoice >= this.limits.voiceConcurrent)
      throw new UsageLimitError(
        "All voice sessions are in use. Try again when another presenter finishes.",
      );
    this.activeVoice++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeVoice--;
      }
    };
  }
  acquireLLM(): () => void {
    const now = this.now();
    this.attempts = this.attempts.filter((at) => at > now - HOUR_MS);
    if (this.attempts.length >= this.limits.llmHourly)
      throw new UsageLimitError(
        "The server’s hourly AI request limit has been reached. Try again later.",
      );
    if (this.activeLLM >= this.limits.llmConcurrent)
      throw new UsageLimitError(
        "The AI service is busy. Wait a moment and try again.",
      );
    this.attempts.push(now);
    this.activeLLM++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.activeLLM--;
      }
    };
  }
  /**
   * A view of this guard for one client key (normally the request IP). The client's own ceilings are
   * checked first, so one visitor cannot drain the shared hourly budget or hold every voice slot.
   */
  forClient(key: string): UsageGate {
    return new ClientUsage(this, key);
  }
  acquireVoiceFor(key: string): () => void {
    const client = this.counters(key);
    if (client.voiceActive >= this.limits.voiceConcurrentPerClient)
      throw new UsageLimitError(
        "You already have the maximum number of microphones open from this address. Stop one to start another.",
      );
    const release = this.acquireVoice();
    client.voiceActive++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      client.voiceActive--;
      release();
    };
  }
  acquireLLMFor(key: string): () => void {
    const now = this.now();
    const client = this.counters(key);
    client.llmAttempts = client.llmAttempts.filter((at) => at > now - HOUR_MS);
    if (client.llmAttempts.length >= this.limits.llmHourlyPerClient)
      throw new UsageLimitError(
        "Your hourly AI request limit has been reached. Try again later.",
      );
    if (client.llmActive >= this.limits.llmConcurrentPerClient)
      throw new UsageLimitError(
        "You already have AI requests in progress. Wait a moment and try again.",
      );
    const release = this.acquireLLM();
    client.llmAttempts.push(now);
    client.llmActive++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      client.llmActive--;
      release();
    };
  }
  snapshot() {
    return {
      voice: this.activeVoice,
      llm: this.activeLLM,
      attempts: this.attempts.filter((at) => at > this.now() - HOUR_MS).length,
      clients: this.clients.size,
    };
  }
  private counters(key: string): ClientCounters {
    const now = this.now();
    let client = this.clients.get(key);
    if (!client) {
      if (this.clients.size >= CLIENT_SWEEP_SIZE) this.sweep(now);
      client = { llmAttempts: [], llmActive: 0, voiceActive: 0, touched: now };
      this.clients.set(key, client);
    }
    client.touched = now;
    return client;
  }
  /** Drops clients with no live work and no attempts inside the rolling hour. */
  private sweep(now: number) {
    for (const [key, client] of this.clients)
      if (
        !client.llmActive &&
        !client.voiceActive &&
        client.touched <= now - HOUR_MS
      )
        this.clients.delete(key);
  }
}
class ClientUsage implements UsageGate {
  constructor(
    private readonly guard: UsageGuard,
    private readonly key: string,
  ) {}
  get limits() {
    return this.guard.limits;
  }
  now() {
    return this.guard.now();
  }
  acquireVoice() {
    return this.guard.acquireVoiceFor(this.key);
  }
  acquireLLM() {
    return this.guard.acquireLLMFor(this.key);
  }
}
/** One budget per browser WebSocket: toggling the microphone never resets it. */
export class VoiceBudget {
  private usedMs = 0;
  private audioBytes = 0;
  private tokens = 64000;
  private updatedAt: number;
  private activeRelease?: () => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private guard: UsageGate) {
    this.updatedAt = guard.now();
  }
  start(onExpire: () => void) {
    if (this.activeRelease)
      throw new UsageLimitError("Microphone is already active.");
    const remaining = this.guard.limits.voiceSeconds * 1000 - this.usedMs;
    if (
      remaining <= 0 ||
      this.audioBytes >= this.guard.limits.voiceSeconds * 32000
    )
      throw new UsageLimitError(
        "This session’s voice allowance is used. Continue with typed cues.",
      );
    const release = this.guard.acquireVoice(),
      started = this.guard.now();
    let stopped = false;
    this.activeRelease = () => {
      if (stopped) return;
      stopped = true;
      this.usedMs += Math.max(0, this.guard.now() - started);
      clearTimeout(this.timer);
      this.timer = undefined;
      this.activeRelease = undefined;
      release();
    };
    this.timer = setTimeout(() => {
      this.stop();
      onExpire();
    }, remaining);
    this.timer.unref?.();
  }
  audio(bytes: number) {
    if (!this.activeRelease) return false;
    if (bytes <= 0 || bytes > 32000 || bytes % 2 !== 0)
      throw new UsageLimitError(
        "Send valid PCM16 chunks of at most one second.",
      );
    const now = this.guard.now();
    this.tokens = Math.min(
      64000,
      this.tokens + Math.max(0, now - this.updatedAt) * 35.2,
    );
    this.updatedAt = now;
    if (bytes > this.tokens)
      throw new UsageLimitError(
        "Audio arrived too quickly. The microphone was stopped; stream live audio in real time.",
      );
    if (this.audioBytes + bytes > this.guard.limits.voiceSeconds * 32000)
      throw new UsageLimitError(
        "This session’s voice allowance is used. Continue with typed cues.",
      );
    this.tokens -= bytes;
    this.audioBytes += bytes;
    return true;
  }
  stop() {
    this.activeRelease?.();
  }
}
