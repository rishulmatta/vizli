import { describe, it, expect } from "vitest";
import { ByteBucket, CountWindow, collabLimitsFromEnv } from "./limits.js";

describe("collab limits", () => {
  it("parses env with defaults and keeps the sync burst equal to the max message", () => {
    const limits = collabLimitsFromEnv({});
    expect(limits.maxRoomSockets).toBe(8);
    expect(limits.syncMaxMessageBytes).toBe(10 * 1024 * 1024);
    expect(collabLimitsFromEnv({ MAX_ROOMS: "3", COLLAB_ROOM_IDLE_MS: "x" })).toMatchObject({ maxRooms: 3, roomIdleMs: 60_000 });
  });
  it("byte bucket allows one full burst immediately, then refills over time", () => {
    let now = 0;
    const bucket = new ByteBucket(1000, 5000, () => now);
    expect(bucket.allow(5000)).toBe(true);
    expect(bucket.allow(1)).toBe(false);
    now = 2000;
    expect(bucket.allow(2000)).toBe(true);
    expect(bucket.allow(1)).toBe(false);
    now = 100_000;
    expect(bucket.allow(5000)).toBe(true);
    expect(bucket.allow(5000)).toBe(false);
  });
  it("count window admits at most N events per sliding second", () => {
    let now = 0;
    const window = new CountWindow(3, () => now);
    expect([window.allow(), window.allow(), window.allow(), window.allow()]).toEqual([true, true, true, false]);
    now = 999;
    expect(window.allow()).toBe(false);
    now = 1000;
    expect(window.allow()).toBe(true);
  });
});
