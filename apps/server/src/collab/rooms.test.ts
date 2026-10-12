import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { createDemoProject, fromPlain, toPlain, PROJECT_ROOT, type Project } from "@vizli/shared";
import { ProjectStore } from "../store.js";
import { collabLimitsFromEnv, type CollabLimits } from "./limits.js";
import { CHANNEL_AWARENESS, CHANNEL_SYNC, DocRoom, RoomError, RoomRegistry, type RoomSocket } from "./rooms.js";

type Frame = { channel: number; body: Uint8Array } | { json: unknown };
type Client = {
  socket: RoomSocket & { frames: Frame[]; closed?: { code?: number; reason?: string } };
  doc: Y.Doc;
  awareness: Awareness;
  attach(room: DocRoom): void;
  plain(): Project;
};
const log = { warn: vi.fn(), info: vi.fn() };
let dir: string;
let store: ProjectStore;
let limits: CollabLimits;

function client(name: string): Client {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  let room: DocRoom | undefined;
  const socket: Client["socket"] = {
    readyState: 1,
    bufferedAmount: 0,
    frames: [],
    send(data) {
      if (typeof data === "string") {
        socket.frames.push({ json: JSON.parse(data) });
        return;
      }
      const decoder = decoding.createDecoder(data);
      const channel = decoding.readVarUint(decoder);
      const body = data.subarray(decoder.pos);
      socket.frames.push({ channel, body });
      if (channel === CHANNEL_SYNC) {
        const reply = encoding.createEncoder();
        readSyncMessage(decoding.createDecoder(body), reply, doc, "server");
        if (encoding.length(reply) > 0 && room) room.handleSync(socket, encoding.toUint8Array(reply));
      } else if (channel === CHANNEL_AWARENESS) {
        applyAwarenessUpdate(awareness, decoding.readVarUint8Array(decoding.createDecoder(body)), "server");
      }
    },
    close(code, reason) {
      socket.readyState = 3;
      socket.closed = { code, reason };
    },
  };
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "server" || !room) return;
    const encoder = encoding.createEncoder();
    writeUpdate(encoder, update);
    room.handleSync(socket, encoding.toUint8Array(encoder));
  });
  awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    if (origin === "server" || !room) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [...added, ...updated, ...removed]));
    room.handleAwareness(socket, encoding.toUint8Array(encoder));
  });
  return {
    socket,
    doc,
    awareness,
    attach(target) {
      room = target;
      const step1 = encoding.createEncoder();
      writeSyncStep1(step1, doc);
      room.handleSync(socket, encoding.toUint8Array(step1));
    },
    plain: () => toPlain(doc),
  };
}
function member(c: Client, name: string, onPlain = vi.fn()) {
  return { socket: c.socket, clientId: `c-${name}`, userId: `u-${name}`, name, color: "#d2432f", onPlain };
}
function relabel(doc: Y.Doc, sceneIndex: number, objectIndex: number, label: string) {
  const scenes = doc.getMap<unknown>(PROJECT_ROOT).get("scenes") as Y.Array<Y.Map<unknown>>;
  const objects = scenes.get(sceneIndex).get("objects") as Y.Array<Y.Map<unknown>>;
  doc.transact(() => objects.get(objectIndex).set("label", label), "test");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "vizli-rooms-"));
  store = new ProjectStore(dir);
  limits = { ...collabLimitsFromEnv({}), saveDebounceMs: 20, saveMaxWaitMs: 60, roomIdleMs: 30 };
  log.warn.mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("RoomRegistry loading", () => {
  it("migrates a plain project, seeds unknown ids, and reports missing ones", async () => {
    const registry = new RoomRegistry(store, limits, log);
    await store.save({ ...createDemoProject(), id: "legacy", title: "Legacy title" });
    const a = client("a");
    const room = await registry.join({ projectId: "legacy" }, member(a, "a"));
    expect(room.project.title).toBe("Legacy title");
    expect(room.docId).toMatch(/[0-9a-f-]{36}/);
    expect(await store.exists("legacy")).toBe("yjs");
    await expect(registry.join({ projectId: "nope" }, member(client("b"), "b"))).rejects.toMatchObject({ code: "project-not-found" });
    const seed = { ...createDemoProject(), id: "fresh", title: "Seeded" };
    const seeded = await registry.join({ projectId: "fresh", seed }, member(client("c"), "c"));
    expect(seeded.project.title).toBe("Seeded");
    await expect(registry.join({ projectId: "other", seed }, member(client("d"), "d"))).rejects.toMatchObject({ code: "invalid-seed" });
    const demo = await registry.join({ projectId: "default" }, member(client("e"), "e"));
    expect(demo.project.scenes.length).toBe(createDemoProject().scenes.length);
    expect(registry.size).toBe(3);
    await registry.closeAll();
  });
  it("caps project creation per hour and preserves unreadable files", async () => {
    const registry = new RoomRegistry(store, { ...limits, projectsCreatedPerHour: 1 }, log);
    await registry.join({ projectId: "p1", seed: { ...createDemoProject(), id: "p1" } }, member(client("a"), "a"));
    await expect(
      registry.join({ projectId: "p2", seed: { ...createDemoProject(), id: "p2" } }, member(client("b"), "b")),
    ).rejects.toMatchObject({ code: "project-limit" });
    await writeFile(join(dir, "broken.json"), "{nope");
    await expect(registry.join({ projectId: "broken" }, member(client("c"), "c"))).rejects.toMatchObject({ code: "project-unreadable" });
    expect(await readFile(join(dir, "broken.json"), "utf8")).toBe("{nope");
    await registry.closeAll();
  });
  it("reloads from the stored document rather than the plain file", async () => {
    const registry = new RoomRegistry(store, limits, log);
    const a = client("a");
    const room = await registry.join({ projectId: "default" }, member(a, "a"));
    a.attach(room);
    await vi.waitFor(() => expect(a.plain().scenes.length).toBeGreaterThan(0));
    relabel(a.doc, 0, 0, "From the document");
    await vi.waitFor(() => expect(room.project.scenes[0].objects[0].label).toBe("From the document"));
    await room.flush();
    await store.save({ ...room.project, title: "Hand edited plain file" });
    await registry.closeAll();
    const second = new RoomRegistry(store, limits, log);
    const reloaded = await second.join({ projectId: "default" }, member(client("b"), "b"));
    expect(reloaded.project.scenes[0].objects[0].label).toBe("From the document");
    expect(reloaded.project.title).not.toBe("Hand edited plain file");
    expect(await second.readPlain("default")).toMatchObject({ title: reloaded.project.title });
    await second.closeAll();
    expect((await second.readPlain("default"))?.scenes[0].objects[0].label).toBe("From the document");
  });
});

describe("DocRoom relay", () => {
  it("syncs two clients through step 1/2, relays updates without echo, and reports self/peer origins", async () => {
    const registry = new RoomRegistry(store, limits, log);
    const a = client("a"), b = client("b");
    const onA = vi.fn(), onB = vi.fn();
    const room = await registry.join({ projectId: "default" }, member(a, "a", onA));
    await registry.join({ projectId: "default" }, member(b, "b", onB));
    a.attach(room);
    b.attach(room);
    await vi.waitFor(() => {
      expect(a.plain().scenes.length).toBe(room.project.scenes.length);
      expect(b.plain().scenes.length).toBe(room.project.scenes.length);
    });
    const versionBefore = room.version;
    relabel(a.doc, 0, 0, "Changed by A");
    expect(room.version).toBe(versionBefore + 1);
    expect(b.plain().scenes[0].objects[0].label).toBe("Changed by A");
    expect(room.project.scenes[0].objects[0].label).toBe("Changed by A");
    const aSyncFramesAfter = a.socket.frames.filter((f) => "channel" in f && f.channel === CHANNEL_SYNC).length;
    relabel(b.doc, 0, 0, "Changed by B");
    expect(a.plain().scenes[0].objects[0].label).toBe("Changed by B");
    await vi.waitFor(() => expect(onB).toHaveBeenCalled());
    expect(onA).toHaveBeenCalledWith("self");
    expect(onB).toHaveBeenCalledWith("self");
    // B's own update came back to A as one frame and never to B.
    expect(a.socket.frames.filter((f) => "channel" in f && f.channel === CHANNEL_SYNC).length).toBe(aSyncFramesAfter + 1);
    const bSyncFrames = b.socket.frames.filter((f) => "channel" in f && f.channel === CHANNEL_SYNC).length;
    relabel(b.doc, 0, 0, "Again by B");
    expect(b.socket.frames.filter((f) => "channel" in f && f.channel === CHANNEL_SYNC).length).toBe(bSyncFrames);
    await registry.closeAll();
  });
  it("relays awareness and removes a member's states when it leaves", async () => {
    const registry = new RoomRegistry(store, limits, log);
    const a = client("a"), b = client("b");
    const room = await registry.join({ projectId: "default" }, member(a, "a"));
    await registry.join({ projectId: "default" }, member(b, "b"));
    a.attach(room);
    b.attach(room);
    b.awareness.setLocalState({ name: "B", cursor: { x: 1, y: 2 } });
    expect(room.awareness.getStates().get(b.doc.clientID)).toMatchObject({ name: "B" });
    expect(a.awareness.getStates().get(b.doc.clientID)).toMatchObject({ name: "B" });
    const c = client("c");
    await registry.join({ projectId: "default" }, member(c, "c"));
    expect(c.awareness.getStates().get(b.doc.clientID)).toMatchObject({ name: "B" });
    room.leave(b.socket);
    expect(room.awareness.getStates().has(b.doc.clientID)).toBe(false);
    expect(a.awareness.getStates().has(b.doc.clientID)).toBe(false);
    await registry.closeAll();
  });
  it("enforces the socket cap and closes slow clients instead of queueing", async () => {
    const registry = new RoomRegistry(store, { ...limits, maxRoomSockets: 1, maxBufferedBytes: 10 }, log);
    const a = client("a");
    const room = await registry.join({ projectId: "default" }, member(a, "a"));
    await expect(registry.join({ projectId: "default" }, member(client("b"), "b"))).rejects.toMatchObject({ code: "room-full" });
    a.socket.bufferedAmount = 11;
    room.sendJson(a.socket, { type: "state", state: "ready" } as never);
    expect(a.socket.closed).toMatchObject({ code: 1013 });
    expect(() => room.handleSync(a.socket, new Uint8Array([200, 1, 2]))).toThrow(RoomError);
    await registry.closeAll();
  });
  it("imports a project into a live room so peers converge", async () => {
    const registry = new RoomRegistry(store, limits, log);
    const a = client("a");
    const room = await registry.join({ projectId: "default" }, member(a, "a"));
    a.attach(room);
    await vi.waitFor(() => expect(a.plain().scenes.length).toBeGreaterThan(0));
    const imported = { ...room.project, title: "Imported title", scenes: room.project.scenes.slice(0, 1) };
    expect(await registry.importProject(imported)).toBe("room");
    expect(a.plain().title).toBe("Imported title");
    expect(a.plain().scenes.length).toBe(1);
    expect(JSON.parse(await readFile(join(dir, "default.json"), "utf8")).title).toBe("Imported title");
    await registry.closeAll();
    expect(await registry.importProject({ ...imported, title: "Offline import" })).toBe("document");
    expect((await registry.readPlain("default"))?.title).toBe("Offline import");
    expect(await registry.importProject({ ...createDemoProject(), id: "brand-new" })).toBe("created");
  });
});

describe("persistence and eviction", () => {
  it("debounces writes, honours the max wait, and evicts idle rooms after a final flush", async () => {
    const registry = new RoomRegistry(store, limits, log);
    const a = client("a");
    const room = await registry.join({ projectId: "default" }, member(a, "a"));
    a.attach(room);
    await vi.waitFor(() => expect(a.plain().scenes.length).toBeGreaterThan(0));
    const before = (await stat(join(dir, "default.yjs"))).mtimeMs;
    const start = Date.now();
    // Continuous edits every 10 ms never let the 20 ms debounce settle; the 60 ms max wait must still write.
    let wrote = false;
    while (Date.now() - start < 120) {
      relabel(a.doc, 0, 0, `tick ${Date.now()}`);
      await new Promise((r) => setTimeout(r, 10));
      if ((await stat(join(dir, "default.yjs"))).mtimeMs > before) wrote = true;
    }
    expect(wrote).toBe(true);
    relabel(a.doc, 0, 0, "final label");
    room.leave(a.socket);
    await vi.waitFor(() => expect(registry.peek("default")).toBeUndefined(), { timeout: 2000 });
    expect(JSON.parse(await readFile(join(dir, "default.json"), "utf8")).scenes[0].objects[0].label).toBe("final label");
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await readFile(join(dir, "default.yjs")));
    expect(toPlain(doc).scenes[0].objects[0].label).toBe("final label");
    const reopened = await registry.join({ projectId: "default" }, member(client("b"), "b"));
    expect(reopened.project.scenes[0].objects[0].label).toBe("final label");
    await registry.closeAll();
  });
  it("evicts idle rooms to make space and refuses when every room is busy", async () => {
    const registry = new RoomRegistry(store, { ...limits, maxRooms: 1, roomIdleMs: 10_000 }, log);
    const a = client("a");
    const first = await registry.join({ projectId: "default" }, member(a, "a"));
    await expect(
      registry.join({ projectId: "second", seed: { ...createDemoProject(), id: "second" } }, member(client("b"), "b")),
    ).rejects.toMatchObject({ code: "rooms-full" });
    first.leave(a.socket);
    const second = await registry.join({ projectId: "second", seed: { ...createDemoProject(), id: "second" } }, member(client("b"), "b"));
    expect(second.projectId).toBe("second");
    expect(registry.peek("default")).toBeUndefined();
    await registry.closeAll();
  });
  it("uses one yjs instance across shared and server", async () => {
    const doc = new Y.Doc();
    fromPlain(doc, createDemoProject(), "load");
    expect(doc.getMap(PROJECT_ROOT).get("scenes")).toBeInstanceOf(Y.Array);
  });
});
