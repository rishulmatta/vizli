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

describe("per-client tables", () => {
  it("keyed window admits N events per key per interval and keeps keys apart", async () => {
    const { KeyedWindow } = await import("./limits.js");
    let now = 0;
    const window = new KeyedWindow(2, 1000, () => now);
    expect([window.allow("a"), window.allow("a"), window.allow("a")]).toEqual([true, true, false]);
    expect(window.allow("b")).toBe(true);
    now = 1000;
    expect(window.allow("a")).toBe(true);
  });
  it("connection table caps live sockets per key and releases idempotently", async () => {
    const { ConnectionTable } = await import("./limits.js");
    const table = new ConnectionTable(2);
    const first = table.acquire("a"), second = table.acquire("a");
    expect(first && second).toBeTruthy();
    expect(table.acquire("a")).toBeNull();
    expect(table.acquire("b")).not.toBeNull();
    first!();
    first!();
    expect(table.count("a")).toBe(1);
    expect(table.acquire("a")).not.toBeNull();
    expect(table.acquire("a")).toBeNull();
  });
  it("reads the new per-client and size limits from the environment", () => {
    expect(collabLimitsFromEnv({})).toMatchObject({
      maxDocBytes: 32 * 1024 * 1024,
      awarenessMaxBytes: 16 * 1024,
      maxSocketsPerClient: 16,
      joinTimeoutMs: 15_000,
      projectsCreatedPerHourPerClient: 20,
    });
    expect(collabLimitsFromEnv({ COLLAB_MAX_DOC_BYTES: "1024", MAX_SOCKETS_PER_CLIENT: "2" })).toMatchObject({ maxDocBytes: 1024, maxSocketsPerClient: 2 });
  });
});
