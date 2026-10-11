import { describe, it, expect, vi } from "vitest";
import {
  createDemoProject,
  ProjectSchema,
  type ServerMessage,
} from "@vizli/shared";
import { VisualSession } from "./session.js";
import { localResolve, ModelResponseError } from "./resolver.js";
const project = createDemoProject();
const resolve = (text: string, scene = project.scenes[0]!) =>
  localResolve({ text, scene, cues: project.cues });
const actions = (messages: ServerMessage[]) =>
  messages.filter((m) => m.type === "action");

describe("semantic scene validation", () => {
  it("accepts seed project and rejects dangling graph endpoints", () => {
    expect(ProjectSchema.safeParse(project).success).toBe(true);
    const bad = structuredClone(project);
    bad.scenes[2]!.connections[0]!.source = "missing";
    expect(ProjectSchema.safeParse(bad).success).toBe(false);
  });
  it("resolves nested matrix row and rejects nonexistent row", () => {
    expect(
      resolve("highlight second row of matrix A", project.scenes[1]).targetId,
    ).toBe("matrix-a:row:1");
    expect(
      resolve("highlight fourth row of matrix A", project.scenes[1]).type,
    ).toBe("skip");
  });
  it("skips ambiguity and tentative mutations", () => {
    expect(resolve("highlight revenue and acquisition cost").type).toBe("skip");
    expect(resolve("maybe add a cache", project.scenes[2]).type).toBe("skip");
  });
  it("resolves a specific chart bar", () => {
    expect(resolve("highlight Social in the growth chart").targetId).toBe(
      "channels:bar:1",
    );
    expect(resolve("highlight Partners").targetId).toBe("channels:bar:2");
  });
});
describe("causal cue lifecycle", () => {
  it("requires render acknowledgement before applied", async () => {
    const messages: ServerMessage[] = [];
    const s = new VisualSession((m) => messages.push(m));
    s.setScene(project.scenes[0]!, 1, []);
    await s.cue("point to revenue");
    expect(
      messages.some((m) => m.type === "state" && m.state === "applied"),
    ).toBe(false);
    s.applied(actions(messages)[0]!.action.id);
    expect(
      messages.some((m) => m.type === "state" && m.state === "applied"),
    ).toBe(true);
    s.close();
  });
  it("discards stale model results after changing scenes", async () => {
    const messages: ServerMessage[] = [];
    let release: () => void = () => {};
    const s = new VisualSession(
      (m) => messages.push(m),
      async () => {
        await new Promise<void>((r) => (release = r));
        return { type: "point", targetId: "revenue", reason: "test" };
      },
    );
    s.setScene(project.scenes[0]!, 1, []);
    const task = s.cue("revenue");
    s.setScene(project.scenes[1]!, 2, []);
    release();
    await task;
    expect(actions(messages)).toHaveLength(0);
    s.close();
  });
  it("deduplicates interim/final cue actions", async () => {
    const messages: ServerMessage[] = [];
    const s = new VisualSession((m) => messages.push(m));
    s.setScene(project.scenes[0]!, 1, []);
    await s.cue("revenue", false, true);
    await s.cue("revenue", true, true);
    expect(actions(messages)).toHaveLength(1);
    s.close();
  });
  it("allows the same target in separate completed speaking turns", async () => {
    const messages: ServerMessage[] = [];
    const s = new VisualSession((m) => messages.push(m));
    s.setScene(project.scenes[0]!, 1, []);
    s.speech("revenue", true);
    await vi.waitFor(() => expect(actions(messages)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 0));
    s.speech("revenue", true);
    await vi.waitFor(() => expect(actions(messages)).toHaveLength(2));
    s.close();
  });
  it("processes sustained interim speech before a final turn event", async () => {
    vi.useFakeTimers();
    const messages: ServerMessage[] = [];
    const s = new VisualSession((m) => messages.push(m));
    try {
      s.setScene(project.scenes[0]!, 1, []);
      s.speech("revenue", false);
      await vi.advanceTimersByTimeAsync(100);
      s.speech("revenue increased", false);
      await vi.advanceTimersByTimeAsync(100);
      s.speech("revenue increased this", false);
      await vi.advanceTimersByTimeAsync(100);
      s.speech("revenue increased this quarter", false);
      await vi.advanceTimersByTimeAsync(30);
      expect(actions(messages)).toHaveLength(1);
    } finally {
      s.close();
      vi.useRealTimers();
    }
  });
  it("stopSpeech removes queued partials and invalidates an in-flight actor", async () => {
    vi.useFakeTimers();
    const messages: ServerMessage[] = [];
    const s = new VisualSession(
      (m) => messages.push(m),
      async () => new Promise(() => {}),
    );
    try {
      s.setScene(project.scenes[0]!, 1, []);
      s.speech("revenue", false);
      s.stopSpeech();
      await vi.advanceTimersByTimeAsync(500);
      expect(
        messages.some((m) => m.type === "state" && m.state === "resolving"),
      ).toBe(false);
      const task = s.cue("revenue", true, true);
      s.stopSpeech();
      await task;
      expect(
        messages.some((m) => m.type === "state" && m.state === "invalidated"),
      ).toBe(true);
      expect(actions(messages)).toHaveLength(0);
    } finally {
      s.close();
      vi.useRealTimers();
    }
  });
  it("keeps a typed cue alive when the microphone lifecycle changes", async () => {
    const messages: ServerMessage[] = [];
    let release = () => {};
    const s = new VisualSession(
      (m) => messages.push(m),
      async (input) =>
        new Promise((resolve) => {
          release = () => resolve(localResolve({ text: input.text, scene: input.scene, cues: input.cues }));
        }),
    );
    try {
      s.setScene(project.scenes[0]!, 1, []);
      const task = s.cue("highlight revenue");
      s.stopSpeech(); // e.g. the user clicks the microphone right after typing
      release();
      await task;
      expect(actions(messages)).toHaveLength(1);
      expect(actions(messages)[0]!.action.targetId).toBe("revenue");
    } finally {
      s.close();
    }
  });
  it("ignores an empty final speech boundary without interpreting it", async () => {
    const messages: ServerMessage[] = [];
    const resolver = vi.fn(async () => ({ type: "skip" as const, reason: "unused" }));
    const s = new VisualSession((m) => messages.push(m), resolver);
    try {
      s.setScene(project.scenes[0]!, 1, []);
      s.speech("", true);
      s.speech("   ", true);
      await Promise.resolve();
      expect(resolver).not.toHaveBeenCalled();
      expect(messages.filter((m) => m.type === "transcript" || m.type === "skipped")).toHaveLength(0);
    } finally {
      s.close();
    }
  });
  it("retracts only speculative partial effects when speech is revised", async () => {
    vi.useFakeTimers();
    const messages: ServerMessage[] = [];
    const s = new VisualSession((m) => messages.push(m));
    try {
      s.setScene(project.scenes[0]!, 1, []);
      // A completed earlier command stays dispatched across later interim revisions.
      await s.cue("point to revenue", true, true);
      const dispatched = actions(messages)[0]!.action;
      s.speech("now the cost", false);
      await vi.advanceTimersByTimeAsync(400);
      s.speech("now our cost", false);
      await vi.advanceTimersByTimeAsync(400);
      expect(actions(messages).some((m) => m.action.type === "clear")).toBe(false);
      s.applied(dispatched.id);
      expect(
        messages.some((m) => m.type === "state" && m.cueId !== undefined && m.state === "applied"),
      ).toBe(true);
      // A speculative emphasis from a partial is cleared with an effects-only clear.
      s.speech("", true);
      s.speech("highlight acquisition cost", false);
      await vi.advanceTimersByTimeAsync(400);
      const speculative = actions(messages).find((m) => m.action.targetId === "acquisition");
      expect(speculative).toBeDefined();
      s.speech("highlight our churn", false);
      await vi.advanceTimersByTimeAsync(400);
      const clear = actions(messages).find((m) => m.action.type === "clear");
      expect(clear?.action.scope).toBe("effects");
    } finally {
      s.close();
      vi.useRealTimers();
    }
  });
  it("times out even when an adapter ignores abort signals", async () => {
    vi.useFakeTimers();
    const messages: ServerMessage[] = [];
    const s = new VisualSession(
      (m) => messages.push(m),
      async () => new Promise(() => {}),
    );
    try {
      s.setScene(project.scenes[0]!, 1, []);
      const task = s.cue("revenue");
      await vi.advanceTimersByTimeAsync(12001);
      await task;
      expect(
        messages.some((m) => m.type === "state" && m.state === "failed"),
      ).toBe(true);
      expect(
        messages.some(
          (m) => m.type === "error" && m.message.includes("timed out"),
        ),
      ).toBe(true);
      expect(actions(messages)).toHaveLength(0);
    } finally {
      s.close();
      vi.useRealTimers();
    }
  });
  it("does not apply persistent changes from partial speech", async () => {
    const messages: ServerMessage[] = [];
    const s = new VisualSession((m) => messages.push(m));
    s.setScene(project.scenes[2]!, 1, []);
    await s.cue("add a cache", false, true);
    expect(actions(messages)).toHaveLength(0);
    await s.cue("add a cache", true, true);
    expect(actions(messages)).toHaveLength(1);
    s.close();
  });
});


it("humanizes malformed model output at the session boundary",async()=>{
  const messages:ServerMessage[]=[];const session=new VisualSession(message=>messages.push(message),async()=>{throw new SyntaxError("Unexpected token private parser payload");});
  try{session.setScene(project.scenes[0]!,1,[]);await session.cue("highlight revenue");const error=messages.find(message=>message.type==="error");expect(error).toEqual({type:"error",message:"I could not read that visual action. Please name the object and try again."});}finally{session.close();}
});

it("waits for final speech after an invalid speculative proposal, but surfaces provider failures", async () => {
  const messages: ServerMessage[] = [];
  const resolver = vi.fn()
    .mockRejectedValueOnce(new ModelResponseError("Invalid visual response"))
    .mockResolvedValueOnce({ type: "highlight", targetId: "revenue", reason: "Named revenue" })
    .mockRejectedValueOnce(new Error("Nebius request failed (401)."))
    .mockRejectedValueOnce(new ModelResponseError("Invalid final visual response"));
  const session = new VisualSession(message => messages.push(message), resolver);
  try {
    session.setScene(project.scenes[0]!, 1, []);
    await session.cue("highlight rev", false, true);
    expect(messages.some(message => message.type === "error")).toBe(false);
    expect(messages.some(message => message.type === "state" && message.state === "skipped")).toBe(true);
    await session.cue("highlight revenue", true, true);
    expect(actions(messages)).toHaveLength(1);
    await session.cue("point to", false, true);
    expect(messages).toContainEqual({ type: "error", message: "Nebius request failed (401)." });
    await session.cue("point to revenue", true, true);
    expect(messages).toContainEqual({ type: "error", message: "Invalid final visual response" });
  } finally { session.close(); }
});
