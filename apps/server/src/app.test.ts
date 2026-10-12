import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import * as Y from "yjs";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { buildApp } from "./app.js";
import { CHANNEL_AWARENESS, CHANNEL_SYNC, frame } from "./collab/rooms.js";
import { PROJECT_ROOT, createDemoProject, toPlain } from "@vizli/shared";

type TestClient = Awaited<ReturnType<typeof connect>>;
let clientCount = 0;
/** Minimal browser stand-in: a real `ws` socket plus a Y.Doc speaking channel-0 sync frames. */
async function connect(app: Awaited<ReturnType<typeof buildApp>>) {
  const address = app.server.listening
    ? `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    : await app.listen({ port: 0, host: "127.0.0.1" });
  const socket = new WebSocket(address.replace("http://", "ws://") + "/api/session");
  const doc = new Y.Doc();
  const json: any[] = [];
  const name = String.fromCharCode(65 + (clientCount++ % 26));
  const clientId = `client-${name}-${clientCount}`;
  socket.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      json.push(JSON.parse(data.toString()));
      return;
    }
    const bytes = new Uint8Array(data);
    const decoder = decoding.createDecoder(bytes);
    if (decoding.readVarUint(decoder) !== CHANNEL_SYNC) return;
    const reply = encoding.createEncoder();
    readSyncMessage(decoding.createDecoder(bytes.subarray(decoder.pos)), reply, doc, "server");
    if (encoding.length(reply) > 0) socket.send(frame(CHANNEL_SYNC, encoding.toUint8Array(reply)));
  });
  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "server" || socket.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    writeUpdate(encoder, update);
    socket.send(frame(CHANNEL_SYNC, encoding.toUint8Array(encoder)));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  const sendJoin = (projectId: string) =>
    socket.send(
      JSON.stringify({ type: "join", projectId, userId: `user-${name}`, clientId, name: `${name}-user`, color: "#d2432f" }),
    );
  return {
    socket,
    doc,
    json,
    clientId,
    name: `${name}-user`,
    sendJoin,
    async join(projectId: string) {
      sendJoin(projectId);
      await vi.waitFor(() => expect(json.some((m) => m.type === "joined")).toBe(true));
      const step1 = encoding.createEncoder();
      writeSyncStep1(step1, doc);
      socket.send(frame(CHANNEL_SYNC, encoding.toUint8Array(step1)));
      await vi.waitFor(() => expect(toPlain(doc).scenes.length).toBeGreaterThan(0));
      return json.find((m) => m.type === "joined");
    },
    cue(text: string) {
      socket.send(JSON.stringify({ type: "cue", text, source: "typed", mode: "presenting" }));
    },
    actions: () => json.filter((m) => m.type === "action").map((m) => m.action),
    errors: () => json.filter((m) => m.type === "error").map((m) => m.code),
  };
}
function relabel(doc: Y.Doc, label: string) {
  const scenes = doc.getMap<unknown>(PROJECT_ROOT).get("scenes") as Y.Array<Y.Map<unknown>>;
  const objects = scenes.get(0).get("objects") as Y.Array<Y.Map<unknown>>;
  doc.transact(() => objects.get(0).set("label", label), "test");
}
describe("local API boundary", () => {
  it("validates writes, preserves edits and rejects foreign origins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vizli-test-"));
    const app = await buildApp({ NODE_ENV: "test", DATA_DIR: dir });
    try {
      expect((await app.inject("/api/status")).json().mode).toBe("demo");
      const project = createDemoProject();
      project.title = "Saved rehearsal";
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/projects/default",
            payload: project,
          })
        ).statusCode,
      ).toBe(200);
      expect((await app.inject("/api/projects/default")).json().title).toBe(
        "Saved rehearsal",
      );
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/projects/default",
            payload: { ...project, scenes: [] },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/api/projects/default",
            headers: { origin: "https://malicious.example" },
            payload: project,
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("WebSocket protocol failures", () => {
  it("rejects malformed messages and reports unavailable microphone honestly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vizli-test-"));
    const app = await buildApp({ NODE_ENV: "test", DATA_DIR: dir });
    const a = await connect(app);
    try {
      a.socket.send("{bad");
      await vi.waitFor(() => expect(a.json.some((m) => m.type === "error")).toBe(true));
      await a.join("default");
      a.socket.send(JSON.stringify({ type: "listen", enabled: true }));
      await vi.waitFor(() => expect(a.json).toContainEqual({ type: "speech", state: "error" }));
      expect(
        a.json.some((m) => m.type === "error" && m.message.includes("NVIDIA_API_KEY")),
      ).toBe(true);
    } finally {
      a.socket.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("explicit cue bursts", () => {
  it("accepts sequential deliberate cues within 150ms", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vizli-test-"));
    const app = await buildApp({ NODE_ENV: "test", DATA_DIR: dir });
    const a = await connect(app);
    try {
      await a.join("default");
      a.cue("highlight revenue");
      await vi.waitFor(() => expect(a.actions()).toHaveLength(1));
      a.cue("highlight acquisition cost");
      await vi.waitFor(() => expect(a.actions()).toHaveLength(2));
      expect(a.actions().map((action) => action.targetId)).toEqual(["revenue", "acquisition"]);
    } finally {
      a.socket.close();
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("collaborative rooms over the session socket", () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  const clients: TestClient[] = [];
  const open = async (env: NodeJS.ProcessEnv = {}) => {
    app = await buildApp({ NODE_ENV: "test", DATA_DIR: dir, ...env });
    return app;
  };
  const client = async () => {
    const c = await connect(app!);
    clients.push(c);
    return c;
  };
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "vizli-collab-"));
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.socket.close();
    await app?.close();
    app = undefined;
    await rm(dir, { recursive: true, force: true });
  });

  it("syncs edits between peers, serves them over HTTP and persists both representations", async () => {
    await open();
    const a = await client();
    const b = await client();
    const joinedA = await a.join("default");
    expect(joinedA).toMatchObject({ projectId: "default", docId: expect.any(String) });
    await b.join("default");
    expect(b.json.find((m) => m.type === "joined").docId).toBe(joinedA.docId);
    relabel(a.doc, "Shared revenue");
    await vi.waitFor(() => expect(toPlain(b.doc).scenes[0]!.objects[0]!.label).toBe("Shared revenue"));
    await vi.waitFor(async () =>
      expect((await app!.inject("/api/projects/default")).json().scenes[0].objects[0].label).toBe(
        "Shared revenue",
      ),
    );
    a.socket.close();
    b.socket.close();
    await app!.close();
    app = undefined;
    const saved = JSON.parse(await readFile(join(dir, "default.json"), "utf8"));
    expect(saved.scenes[0].objects[0].label).toBe("Shared revenue");
    expect((await stat(join(dir, "default.yjs"))).size).toBeGreaterThan(0);
  });

  it("requires a single join before other messages and ignores pre-join binary frames", async () => {
    await open();
    const a = await client();
    a.cue("highlight revenue");
    await vi.waitFor(() => expect(a.errors()).toContain("not-joined"));
    a.socket.send(frame(CHANNEL_SYNC, new Uint8Array([0, 0])));
    await a.join("default");
    expect(a.socket.readyState).toBe(WebSocket.OPEN);
    a.sendJoin("default");
    await vi.waitFor(() => expect(a.errors()).toContain("already-joined"));
    expect(a.errors()).not.toContain("bad-frame");
  });

  it("fans temporary effects out to peers without leaking the presenter's transcript", async () => {
    await open();
    const a = await client();
    const b = await client();
    await a.join("default");
    await b.join("default");
    const bBefore = b.json.length;
    a.cue("highlight revenue");
    await vi.waitFor(() => expect(a.actions()).toHaveLength(1));
    await vi.waitFor(() =>
      expect(b.json.filter((m) => m.type === "effect")).toHaveLength(1),
    );
    const effect = b.json.find((m) => m.type === "effect");
    expect(effect).toMatchObject({ clientId: a.clientId, name: a.name, action: { type: "highlight", targetId: "revenue" } });
    expect(effect.action.revision).toBe(a.actions()[0]!.revision);
    const leaked = b.json.slice(bBefore).filter((m) => m.type !== "effect");
    expect(leaked).toEqual([]);
    expect(a.json.some((m) => m.type === "effect")).toBe(false);
  });

  it("converges a joined client onto a project imported over HTTP", async () => {
    await open();
    const a = await client();
    await a.join("default");
    const project = createDemoProject();
    project.title = "Imported while joined";
    const response = await app!.inject({ method: "PUT", url: "/api/projects/default", payload: project });
    expect(response.json()).toEqual({ ok: true, mode: "room" });
    await vi.waitFor(() => expect(toPlain(a.doc).title).toBe("Imported while joined"));
  });

  it("closes on oversized sync frames and drops awareness floods without closing", async () => {
    await open({ COLLAB_SYNC_MAX_MESSAGE_BYTES: "512" });
    const a = await client();
    await a.join("default");
    const awareness = new Awareness(a.doc);
    awareness.setLocalState({ name: "A" });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [a.doc.clientID]));
    const presence = frame(CHANNEL_AWARENESS, encoding.toUint8Array(encoder));
    for (let i = 0; i < 200; i++) a.socket.send(presence);
    a.cue("highlight revenue");
    await vi.waitFor(() => expect(a.actions()).toHaveLength(1));
    expect(a.socket.readyState).toBe(WebSocket.OPEN);
    expect(a.errors()).toEqual([]);
    awareness.destroy();
    const closed = new Promise<number>((resolve) => a.socket.once("close", (code) => resolve(code)));
    a.socket.send(frame(CHANNEL_SYNC, new Uint8Array(4096)));
    expect(await closed).toBe(1009);
  });

  it("closes after repeated unreadable frames", async () => {
    await open();
    const a = await client();
    await a.join("default");
    const closed = new Promise<number>((resolve) => a.socket.once("close", (code) => resolve(code)));
    for (let i = 0; i < 5; i++) a.socket.send(frame(7, new Uint8Array([1])));
    expect(await closed).toBe(1007);
    expect(a.errors().filter((code) => code === "bad-frame").length).toBeGreaterThanOrEqual(4);
  });

  it("creates projects with fresh ids and reports unknown ones", async () => {
    await open();
    const created = await app!.inject({ method: "POST", url: "/api/projects", payload: { template: "demo" } });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    expect(id).toMatch(/^p-[0-9a-f]{16}$/);
    const project = { ...createDemoProject(), title: "Own copy" };
    const second = await app!.inject({ method: "POST", url: "/api/projects", payload: { project } });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).not.toBe(id);
    const read = await app!.inject(`/api/projects/${second.json().id}`);
    expect(read.json()).toMatchObject({ id: second.json().id, title: "Own copy" });
    expect((await app!.inject(`/api/projects/${id}`)).json().id).toBe(id);
    expect((await app!.inject("/api/projects/p-unknown")).statusCode).toBe(404);
    expect((await app!.inject("/api/projects/bad.id")).statusCode).toBe(400);
    expect((await app!.inject({ method: "POST", url: "/api/projects", payload: { template: "other" } })).statusCode).toBe(400);
    const a = await client();
    await a.join(id);
    expect(toPlain(a.doc).id).toBe(id);
    expect((await app!.inject("/api/status")).json().collab).toEqual({ rooms: 1 });
  });
});

describe("configured API port", () => {
  it("trusts the built app served from the configured PORT without listing it manually", async () => {
    const app = await buildApp({ NODE_ENV: "test", PORT: "3005" });
    try {
      const sameApp = await app.inject({
        url: "/api/status",
        headers: { origin: "http://127.0.0.1:3005" },
      });
      expect(sameApp.statusCode).toBe(200);
      const oldDefault = await app.inject({
        url: "/api/status",
        headers: { origin: "http://127.0.0.1:3001" },
      });
      expect(oldDefault.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });
});

describe("provider status", () => {
  it("reports Nemotron tiers and routing without credentials, and local rules in demo mode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vizli-test-"));
    try {
      const demo = await buildApp({ NODE_ENV: "test", DATA_DIR: dir });
      expect((await demo.inject("/api/status")).json()).toMatchObject({ mode: "demo", models: null, routing: "local-rules", provider: null });
      await demo.close();
      const live = await buildApp({ NODE_ENV: "test", DATA_DIR: dir, NEBIUS_API_KEY: "secret-sentinel", NEBIUS_MODEL: "nvidia/nemotron-3-super-120b-a12b", NEBIUS_FAST_MODEL: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", NEBIUS_REASONING_MODEL: "nvidia/Nemotron-3-Ultra-550b-a55b" });
      const body = (await live.inject("/api/status")).body;
      expect(JSON.parse(body)).toMatchObject({ mode: "live", routing: "nemotron-first", provider: "nebius-token-factory", models: { fast: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", core: "nvidia/nemotron-3-super-120b-a12b", reasoning: "nvidia/Nemotron-3-Ultra-550b-a55b" } });
      expect(body).not.toContain("secret-sentinel");
      await live.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
