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
