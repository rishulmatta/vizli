import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoProject } from "@vizli/shared";
import { ProjectStore } from "./store.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "vizli-store-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("ProjectStore", () => {
  it("stores plain projects and Yjs updates side by side", async () => {
    const store = new ProjectStore(dir);
    const project = { ...createDemoProject(), id: "p1" };
    expect(await store.exists("p1")).toBeNull();
    expect(await store.loadJson("p1")).toBeNull();
    expect(await store.loadUpdate("p1")).toBeNull();
    await store.save(project);
    expect(await store.exists("p1")).toBe("json");
    expect((await store.loadJson("p1"))?.title).toBe(project.title);
    const update = new Uint8Array([1, 2, 3, 250]);
    await store.saveUpdate("p1", update);
    expect(await store.exists("p1")).toBe("yjs");
    expect(Array.from((await store.loadUpdate("p1"))!)).toEqual([1, 2, 3, 250]);
    expect(await readFile(join(dir, "p1.json"), "utf8")).toContain(project.title);
  });
  it("rejects invalid ids and preserves unreadable plain files", async () => {
    const store = new ProjectStore(dir);
    await expect(store.loadJson("../x")).rejects.toThrow("Invalid project ID");
    await writeFile(join(dir, "bad.json"), "{not json");
    await expect(store.loadJson("bad")).rejects.toThrow();
    expect(await readFile(join(dir, "bad.json"), "utf8")).toBe("{not json");
  });
  it("detects a plain file written after the document", async () => {
    const store = new ProjectStore(dir);
    await store.saveUpdate("p2", new Uint8Array([1]));
    await store.save({ ...createDemoProject(), id: "p2" });
    expect(await store.jsonNewerThanUpdate("p2")).toBe(false);
    const future = new Date(Date.now() + 60_000);
    await utimes(join(dir, "p2.json"), future, future);
    expect(await store.jsonNewerThanUpdate("p2")).toBe(true);
    expect(await store.jsonNewerThanUpdate("missing")).toBe(false);
  });
});
