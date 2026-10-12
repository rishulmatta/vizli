import { expect, vi } from "vitest";
import WebSocket from "ws";
import * as Y from "yjs";
import { readSyncMessage, writeSyncStep1, writeUpdate } from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { buildApp } from "./app.js";
import { CHANNEL_SYNC, frame } from "./collab/rooms.js";
import { PROJECT_ROOT, createDemoProject, toPlain } from "@vizli/shared";

export type App = Awaited<ReturnType<typeof buildApp>>;
export type TestClient = Awaited<ReturnType<typeof connect>>;
let clientCount = 0;
/** Creates a project over HTTP; the response carries the edit token exactly once. */
export async function createProject(app: App, project = createDemoProject()) {
  const response = await app.inject({ method: "POST", url: "/api/projects", payload: { project } });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; editToken: string };
}
/** Minimal browser stand-in: a real `ws` socket plus a Y.Doc speaking channel-0 sync frames. */
export async function connect(app: App, options: { headers?: Record<string, string> } = {}) {
  const address = app.server.listening
    ? `http://127.0.0.1:${(app.server.address() as { port: number }).port}`
    : await app.listen({ port: 0, host: "127.0.0.1" });
  const socket = new WebSocket(address.replace("http://", "ws://") + "/api/session", { headers: options.headers });
  const doc = new Y.Doc();
  const json: any[] = [];
  const name = String.fromCharCode(65 + (clientCount++ % 26));
  const clientId = `client-${name}-${clientCount}`;
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
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
  const sendJoin = (projectId: string, token?: string) =>
    socket.send(
      JSON.stringify({
        type: "join",
        projectId,
        userId: `user-${name}`,
        clientId,
        name: `${name}-user`,
        color: "#d2432f",
        ...(token ? { token } : {}),
      }),
    );
  return {
    socket,
    doc,
    json,
    clientId,
    name: `${name}-user`,
    closed,
    sendJoin,
    async join(projectId: string, token?: string) {
      sendJoin(projectId, token);
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
export function relabel(doc: Y.Doc, label: string) {
  const scenes = doc.getMap<unknown>(PROJECT_ROOT).get("scenes") as Y.Array<Y.Map<unknown>>;
  const objects = scenes.get(0).get("objects") as Y.Array<Y.Map<unknown>>;
  doc.transact(() => objects.get(0).set("label", label), "test");
}
/** Writes a large `text` on the first object: one update of roughly `bytes` bytes. */
export function bloat(doc: Y.Doc, bytes: number) {
  const scenes = doc.getMap<unknown>(PROJECT_ROOT).get("scenes") as Y.Array<Y.Map<unknown>>;
  const objects = scenes.get(0).get("objects") as Y.Array<Y.Map<unknown>>;
  doc.transact(() => objects.get(0).set("text", "x".repeat(bytes)), "test");
}
