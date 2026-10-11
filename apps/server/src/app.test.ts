import { describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { createDemoProject } from "@vizli/shared";
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
    const app = await buildApp({ NODE_ENV: "test" });
    await app.ready();
    const socket = await app.injectWS("/api/session");
    const next = () =>
      new Promise<any>((resolve) =>
        socket.once("message", (data) => resolve(JSON.parse(data.toString()))),
      );
    try {
      const invalid = next();
      socket.send("{bad");
      expect((await invalid).type).toBe("error");
      const result: any[] = [];
      const finished = new Promise<void>((resolve) =>
        socket.on("message", (data) => {
          const message = JSON.parse(data.toString());
          result.push(message);
          if (message.type === "speech") resolve();
        }),
      );
      socket.send(JSON.stringify({ type: "listen", enabled: true }));
      await finished;
      expect(result).toContainEqual({ type: "speech", state: "error" });
      expect(
        result.some(
          (m) => m.type === "error" && m.message.includes("NVIDIA_API_KEY"),
        ),
      ).toBe(true);
    } finally {
      socket.close();
      await app.close();
    }
  });
});


describe("explicit cue bursts",()=>{
 it("accepts sequential deliberate cues within 150ms",async()=>{
  const app=await buildApp({NODE_ENV:"test"});await app.ready();const socket=await app.injectWS("/api/session");
  const nextAction=()=>new Promise<any>(resolve=>{const handler=(data:Buffer)=>{const message=JSON.parse(data.toString());if(message.type==="action"){socket.off("message",handler);resolve(message);}};socket.on("message",handler);});
  try{
   socket.send(JSON.stringify({type:"scene",scene:createDemoProject().scenes[0],revision:1,cues:[]}));
   const first=nextAction();socket.send(JSON.stringify({type:"cue",text:"highlight revenue",source:"typed",mode:"presenting"}));expect((await first).action.targetId).toBe("revenue");
   const second=nextAction();socket.send(JSON.stringify({type:"cue",text:"highlight acquisition cost",source:"typed",mode:"presenting"}));expect((await second).action.targetId).toBe("acquisition");
  }finally{socket.close();await app.close();}
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
