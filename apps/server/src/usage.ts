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
  };
}
export class UsageGuard {
  private activeVoice = 0;
  private activeLLM = 0;
  private attempts: number[] = [];
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
    this.attempts = this.attempts.filter((at) => at > now - 3600000);
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
  snapshot() {
    return {
      voice: this.activeVoice,
      llm: this.activeLLM,
      attempts: this.attempts.filter((at) => at > this.now() - 3600000).length,
    };
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
  constructor(private guard: UsageGuard) {
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
