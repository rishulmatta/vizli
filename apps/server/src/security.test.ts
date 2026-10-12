import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as Y from "yjs";
import { createDemoProject, fromPlain, toPlain } from "@vizli/shared";
import {
  CLOSE_JOIN_TIMEOUT,
  CLOSE_PROJECT_DELETED,
  CLOSE_TOO_MANY_CONNECTIONS,
  CLOSE_WRITE_REFUSED,
  buildApp,
  contentSecurityPolicy,
  redactUrl,
  trustProxyFromEnv,
} from "./app.js";
import { CHANNEL_AWARENESS, frame } from "./collab/rooms.js";
import { bloat, connect, createProject, relabel, type App, type TestClient } from "./socket-test-support.js";

const dirs: string[] = [];
const apps: App[] = [];
const clients: TestClient[] = [];
async function open(env: NodeJS.ProcessEnv = {}) {
  const dir = await mkdtemp(join(tmpdir(), "vizli-security-"));
  dirs.push(dir);
  const app = await buildApp({ NODE_ENV: "test", DATA_DIR: dir, ...env });
  apps.push(app);
  return { app, dir };
}
async function client(app: App, headers?: Record<string, string>) {
  const c = await connect(app, { headers });
  clients.push(c);
  return c;
}
afterEach(async () => {
  for (const c of clients.splice(0)) c.socket.close();
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("response hardening", () => {
  it("sets security headers and a same-origin content security policy on every response", async () => {
    const { app } = await open({ CSP_CONNECT_SRC: "https://project.supabase.co, javascript:alert(1)" });
    const response = await app.inject({ url: "/api/status", headers: { host: "vizli.example" } });
    expect(response.headers).toMatchObject({
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      "cross-origin-opener-policy": "same-origin",
    });
    expect(response.headers["permissions-policy"]).toContain("microphone=(self)");
    const csp = String(response.headers["content-security-policy"]);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("img-src 'self' data: https://upload.wikimedia.org https://thumb.wikimedia.org");
    expect(csp).toContain("connect-src 'self' ws://vizli.example wss://vizli.example https://project.supabase.co");
    expect(csp).not.toContain("javascript:");
    expect(response.headers["strict-transport-security"]).toBeUndefined();
    const notFound = await app.inject({ url: "/api/nothing" });
    expect(notFound.headers["content-security-policy"]).toBeDefined();
  });
  it("sends HSTS only once a trusted proxy reports HTTPS", async () => {
    const { app } = await open({ TRUST_PROXY: "1" });
    const secure = await app.inject({ url: "/api/status", headers: { "x-forwarded-proto": "https" } });
    expect(secure.headers["strict-transport-security"]).toBe("max-age=15552000");
    const { app: untrusted } = await open();
    const plain = await untrusted.inject({ url: "/api/status", headers: { "x-forwarded-proto": "https" } });
    expect(plain.headers["strict-transport-security"]).toBeUndefined();
  });
  it("redacts project ids from request logs and parses TRUST_PROXY and hosts defensively", () => {
    expect(redactUrl("/api/projects/p-0123456789abcdef")).toBe("/api/projects/[id]");
    expect(redactUrl("/p/p-0123456789abcdef?x=1#edit=secret")).toBe("/p/[id]?x=1#edit=secret".replace("?x=1#edit=secret", "?x=1#edit=secret"));
    expect(redactUrl("/api/status")).toBe("/api/status");
    expect(trustProxyFromEnv(undefined)).toBe(false);
    expect(trustProxyFromEnv("false")).toBe(false);
    expect(trustProxyFromEnv("true")).toBe(true);
    const oneHop = trustProxyFromEnv("1");
    expect(typeof oneHop).toBe("function");
    expect((oneHop as (a: string, hop: number) => boolean)("10.0.0.1", 0)).toBe(true);
    expect((oneHop as (a: string, hop: number) => boolean)("10.0.0.1", 1)).toBe(false);
    expect(contentSecurityPolicy("evil host; script-src *")).not.toContain("ws://");
    expect(contentSecurityPolicy("[::1]:3001")).toContain("wss://[::1]:3001");
  });
});

describe("roles over the session socket", () => {
  it("lets viewers read and follow but refuses their writes, cues and microphone", async () => {
    const { app } = await open();
    const { id, editToken } = await createProject(app);
    const editor = await client(app);
    const viewer = await client(app);
    expect((await editor.join(id, editToken)).role).toBe("editor");
    expect((await viewer.join(id)).role).toBe("viewer");
    viewer.cue("highlight revenue");
    await vi.waitFor(() => expect(viewer.errors()).toContain("read-only"));
    expect(viewer.actions()).toEqual([]);
    expect(editor.json.filter((m) => m.type === "effect")).toEqual([]);
    viewer.socket.send(JSON.stringify({ type: "listen", enabled: true }));
    await vi.waitFor(() => expect(viewer.json).toContainEqual({ type: "speech", state: "off" }));
    expect(viewer.socket.readyState).toBe(1);
    editor.cue("highlight revenue");
    await vi.waitFor(() => expect(editor.actions()).toHaveLength(1));
    await vi.waitFor(() => expect(viewer.json.filter((m) => m.type === "effect")).toHaveLength(1));
    relabel(editor.doc, "By the editor");
    await vi.waitFor(() => expect(toPlain(viewer.doc).scenes[0]!.objects[0]!.label).toBe("By the editor"));
    // A write from a viewer is never applied: the socket closes so the replica reloads the server state.
    relabel(viewer.doc, "Vandalised");
    expect((await viewer.closed).code).toBe(CLOSE_WRITE_REFUSED);
    expect(viewer.errors()).toContain("read-only");
    expect(toPlain(editor.doc).scenes[0]!.objects[0]!.label).toBe("By the editor");
    expect((await app.inject(`/api/projects/${id}`)).json().scenes[0].objects[0].label).toBe("By the editor");
    const again = await client(app);
    expect((await again.join(id)).role).toBe("viewer");
    expect(toPlain(again.doc).scenes[0]!.objects[0]!.label).toBe("By the editor");
  });
  it("refuses writes past the document size cap, keeps peers consistent and still allows small cleanups", async () => {
    const probe = new Y.Doc();
    fromPlain(probe, createDemoProject(), "load");
    const baseline = Y.encodeStateAsUpdate(probe).byteLength;
    probe.destroy();
    const { app } = await open({ COLLAB_MAX_DOC_BYTES: String(baseline + 4000) });
    const { id, editToken } = await createProject(app);
    const a = await client(app);
    const b = await client(app);
    await a.join(id, editToken);
    await b.join(id, editToken);
    bloat(a.doc, 30_000);
    expect((await a.closed).code).toBe(CLOSE_WRITE_REFUSED);
    expect(a.errors()).toContain("document-full");
    expect(toPlain(b.doc).scenes[0]!.objects[0]!.text?.length ?? 0).toBeLessThan(30_000);
    expect(((await app.inject(`/api/projects/${id}`)).json().scenes[0].objects[0].text ?? "").length).toBeLessThan(30_000);
    // The same client comes back with a fresh replica and can keep making ordinary edits.
    const c = await client(app);
    await c.join(id, editToken);
    relabel(c.doc, "Small change");
    await vi.waitFor(() => expect(toPlain(b.doc).scenes[0]!.objects[0]!.label).toBe("Small change"));
    const huge = { ...createDemoProject(), cues: [], scenes: [{ ...createDemoProject().scenes[0]!, objects: createDemoProject().scenes[0]!.objects.map((o) => ({ ...o, text: "z".repeat(5000) })) }] };
    expect((await app.inject({ method: "POST", url: "/api/projects", payload: { project: huge } })).statusCode).toBe(413);
    const imported = await app.inject({
      method: "PUT",
      url: `/api/projects/${id}`,
      headers: { authorization: `Bearer ${editToken}` },
      payload: { ...huge, id },
    });
    expect(imported.statusCode).toBe(413);
  });
  it("counts oversized awareness frames as unreadable frames", async () => {
    const { app } = await open({ COLLAB_AWARENESS_MAX_BYTES: "64" });
    const { id, editToken } = await createProject(app);
    const a = await client(app);
    await a.join(id, editToken);
    const awareness = new Awareness(a.doc);
    awareness.setLocalState({ name: "A", junk: "j".repeat(500) });
    const encoder = encoding.createEncoder();
    encoding.writeVarUint8Array(encoder, encodeAwarenessUpdate(awareness, [a.doc.clientID]));
    a.socket.send(frame(CHANNEL_AWARENESS, encoding.toUint8Array(encoder)));
    await vi.waitFor(() => expect(a.errors()).toContain("bad-frame"));
    awareness.destroy();
  });
});

describe("per-client connection and creation limits", () => {
  it("closes sockets that never join and caps open sockets per client address", async () => {
    const { app } = await open({ SOCKET_JOIN_TIMEOUT_MS: "300", MAX_SOCKETS_PER_CLIENT: "2" });
    const idle = await client(app);
    const second = await client(app);
    const third = await client(app);
    expect((await third.closed).code).toBe(CLOSE_TOO_MANY_CONNECTIONS);
    expect((await idle.closed).code).toBe(CLOSE_JOIN_TIMEOUT);
    expect((await second.closed).code).toBe(CLOSE_JOIN_TIMEOUT);
    // Slots are released on close, so a new connection that joins promptly is welcome.
    const { id, editToken } = await createProject(app);
    const prompt = await client(app);
    await prompt.join(id, editToken);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(prompt.socket.readyState).toBe(1);
  });
  it("keys clients by the proxied address only when TRUST_PROXY is set", async () => {
    const { app } = await open({ MAX_SOCKETS_PER_CLIENT: "1", TRUST_PROXY: "1" });
    const first = await client(app, { "x-forwarded-for": "203.0.113.1" });
    const other = await client(app, { "x-forwarded-for": "203.0.113.2" });
    const same = await client(app, { "x-forwarded-for": "203.0.113.1" });
    expect((await same.closed).code).toBe(CLOSE_TOO_MANY_CONNECTIONS);
    expect(first.socket.readyState).toBe(1);
    expect(other.socket.readyState).toBe(1);
    const { app: direct } = await open({ MAX_SOCKETS_PER_CLIENT: "1" });
    await client(direct, { "x-forwarded-for": "203.0.113.1" });
    const spoofed = await client(direct, { "x-forwarded-for": "203.0.113.2" });
    expect((await spoofed.closed).code).toBe(CLOSE_TOO_MANY_CONNECTIONS);
  });
  it("limits project creation per client before the shared hourly cap", async () => {
    const { app } = await open({ MAX_PROJECTS_CREATED_PER_HOUR_PER_CLIENT: "1" });
    expect((await app.inject({ method: "POST", url: "/api/projects", payload: { template: "demo" } })).statusCode).toBe(201);
    const second = await app.inject({ method: "POST", url: "/api/projects", payload: { template: "demo" } });
    expect(second.statusCode).toBe(429);
    expect(second.json().error).toContain("You have created");
  });
});

describe("operator deletion", () => {
  it("requires ADMIN_TOKEN, closes connected sockets, removes every file and resets the demo", async () => {
    const { app, dir } = await open({ ADMIN_TOKEN: "operator-secret-0123456789" });
    const { id, editToken } = await createProject(app);
    const a = await client(app);
    await a.join(id, editToken);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${id}` })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: { authorization: `Bearer ${editToken}` } })).statusCode,
    ).toBe(403);
    const admin = { authorization: "Bearer operator-secret-0123456789" };
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: admin })).statusCode).toBe(204);
    expect((await a.closed).code).toBe(CLOSE_PROJECT_DELETED);
    expect(a.errors()).toContain("project-deleted");
    expect((await app.inject(`/api/projects/${id}`)).statusCode).toBe(404);
    expect((await readdir(dir)).filter((file) => file.startsWith(id))).toEqual([]);
    expect((await app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: admin })).statusCode).toBe(404);
    // The demo has nothing stored until someone opens it; afterwards deleting it resets to the built-in project.
    const viewer = await client(app);
    await viewer.join("default");
    expect((await app.inject({ method: "DELETE", url: "/api/projects/default", headers: admin })).statusCode).toBe(204);
    expect((await viewer.closed).code).toBe(CLOSE_PROJECT_DELETED);
    expect((await app.inject("/api/projects/default")).json().title).toBe(createDemoProject().title);
  });
  it("is disabled without ADMIN_TOKEN", async () => {
    const { app } = await open();
    const { id } = await createProject(app);
    const response = await app.inject({ method: "DELETE", url: `/api/projects/${id}`, headers: { authorization: "Bearer anything-at-all-0123456789" } });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain("ADMIN_TOKEN");
    expect((await app.inject(`/api/projects/${id}`)).statusCode).toBe(200);
  });
});
