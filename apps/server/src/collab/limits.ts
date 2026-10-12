import { limit } from "../usage.js";
/** Single-process bounds for collaborative rooms; not billing or authentication. */
export type CollabLimits = {
  maxRooms: number;
  maxRoomSockets: number;
  roomIdleMs: number;
  saveDebounceMs: number;
  saveMaxWaitMs: number;
  projectsCreatedPerHour: number;
  syncBytesPerSecond: number;
  syncMaxMessageBytes: number;
  awarenessPerSecond: number;
  maxBufferedBytes: number;
  /** Encoded document size a room may grow to before writes are refused (see docs/SECURITY.md). */
  maxDocBytes: number;
  /** Largest awareness frame relayed to peers; presence needs a few hundred bytes. */
  awarenessMaxBytes: number;
  /** Open `/api/session` sockets per client address. */
  maxSocketsPerClient: number;
  /** A socket that has not joined a project within this time is closed. */
  joinTimeoutMs: number;
  /** Project creations (POST and seeded joins) per client address per hour. */
  projectsCreatedPerHourPerClient: number;
};
export function collabLimitsFromEnv(env: NodeJS.ProcessEnv): CollabLimits {
  const syncMaxMessageBytes = limit(env.COLLAB_SYNC_MAX_MESSAGE_BYTES, 10 * 1024 * 1024);
  return {
    maxRooms: limit(env.MAX_ROOMS, 100),
    maxRoomSockets: limit(env.MAX_ROOM_SOCKETS, 8),
    roomIdleMs: limit(env.COLLAB_ROOM_IDLE_MS, 60_000),
    saveDebounceMs: limit(env.COLLAB_SAVE_DEBOUNCE_MS, 1000),
    saveMaxWaitMs: limit(env.COLLAB_SAVE_MAX_WAIT_MS, 5000),
    projectsCreatedPerHour: limit(env.MAX_PROJECTS_CREATED_PER_HOUR, 200),
    syncBytesPerSecond: limit(env.COLLAB_SYNC_BYTES_PER_SECOND, 2 * 1024 * 1024),
    syncMaxMessageBytes,
    awarenessPerSecond: limit(env.COLLAB_AWARENESS_PER_SECOND, 30),
    maxBufferedBytes: limit(env.COLLAB_MAX_BUFFERED_BYTES, 16 * 1024 * 1024),
    maxDocBytes: limit(env.COLLAB_MAX_DOC_BYTES, 32 * 1024 * 1024),
    awarenessMaxBytes: limit(env.COLLAB_AWARENESS_MAX_BYTES, 16 * 1024),
    maxSocketsPerClient: limit(env.MAX_SOCKETS_PER_CLIENT, 16),
    joinTimeoutMs: limit(env.SOCKET_JOIN_TIMEOUT_MS, 15_000),
    projectsCreatedPerHourPerClient: limit(env.MAX_PROJECTS_CREATED_PER_HOUR_PER_CLIENT, 20),
  };
}
/** Token bucket in bytes. The burst must be at least one maximum message so an initial sync is never refused. */
export class ByteBucket {
  private tokens: number;
  private last: number;
  constructor(
    private readonly ratePerSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }
  allow(bytes: number): boolean {
    const at = this.now();
    this.tokens = Math.min(
      this.burst,
      this.tokens + ((at - this.last) / 1000) * this.ratePerSecond,
    );
    this.last = at;
    if (bytes > this.tokens) return false;
    this.tokens -= bytes;
    return true;
  }
}
/** Sliding one-second window of event counts. */
export class CountWindow {
  private times: number[] = [];
  constructor(
    private readonly perSecond: number,
    private readonly now: () => number = Date.now,
  ) {}
  allow(): boolean {
    const at = this.now();
    this.times = this.times.filter((t) => at - t < 1000);
    if (this.times.length >= this.perSecond) return false;
    this.times.push(at);
    return true;
  }
}
/** Idle keys are swept once a table grows past this many entries. */
const KEY_SWEEP_SIZE = 512;
/** Per-key sliding window: at most `perInterval` events per `intervalMs` for each key (e.g. creations per client per hour). */
export class KeyedWindow {
  private readonly times = new Map<string, number[]>();
  constructor(
    private readonly perInterval: number,
    private readonly intervalMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  allow(key: string): boolean {
    const at = this.now();
    const kept = (this.times.get(key) ?? []).filter((t) => at - t < this.intervalMs);
    if (kept.length >= this.perInterval) {
      this.times.set(key, kept);
      return false;
    }
    kept.push(at);
    if (!this.times.has(key) && this.times.size >= KEY_SWEEP_SIZE) this.sweep(at);
    this.times.set(key, kept);
    return true;
  }
  private sweep(at: number) {
    for (const [key, times] of this.times)
      if (!times.some((t) => at - t < this.intervalMs)) this.times.delete(key);
  }
}
/** Live connections per key. `acquire` returns a release function, or null when the key is at its cap. */
export class ConnectionTable {
  private readonly counts = new Map<string, number>();
  constructor(private readonly max: number) {}
  acquire(key: string): (() => void) | null {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.max) return null;
    this.counts.set(key, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.counts.get(key) ?? 1) - 1;
      if (next <= 0) this.counts.delete(key);
      else this.counts.set(key, next);
    };
  }
  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}
