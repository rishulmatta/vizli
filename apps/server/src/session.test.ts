import { describe, it, expect, vi } from "vitest";
import {
  applyPresentationStep,
  createDemoProject,
  ProjectSchema,
  type ServerMessage,
} from "@vizli/shared";
import { VisualSession } from "./session.js";
import { memorySource } from "./test-support.js";
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
    memorySource(project.scenes[0]!).attach(s);
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
    const src = memorySource(project.scenes[0]!);
    src.attach(s);
    const task = s.cue("revenue");
    src.set(project.scenes[1]!);
    s.sync("self");
    release();
    await task;
    expect(actions(messages)).toHaveLength(0);
    s.close();
  });
  it("deduplicates interim/final cue actions", async () => {
    const messages: ServerMessage[] = [];
    const s = new VisualSession((m) => messages.push(m));
    memorySource(project.scenes[0]!).attach(s);
    await s.cue("revenue", false, true);
    await s.cue("revenue", true, true);
    expect(actions(messages)).toHaveLength(1);
    s.close();
  });
  it("allows the same target in separate completed speaking turns", async () => {
    const messages: ServerMessage[] = [];
    const s = new VisualSession((m) => messages.push(m));
    memorySource(project.scenes[0]!).attach(s);
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
      memorySource(project.scenes[0]!).attach(s);
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
      memorySource(project.scenes[0]!).attach(s);
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
      memorySource(project.scenes[0]!).attach(s);
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
      memorySource(project.scenes[0]!).attach(s);
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
      memorySource(project.scenes[0]!).attach(s);
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
      memorySource(project.scenes[0]!).attach(s);
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
    memorySource(project.scenes[2]!).attach(s);
    await s.cue("add a cache", false, true);
    expect(actions(messages)).toHaveLength(0);
    await s.cue("add a cache", true, true);
    expect(actions(messages)).toHaveLength(1);
    s.close();
  });
});


it("humanizes malformed model output at the session boundary",async()=>{
  const messages:ServerMessage[]=[];const session=new VisualSession(message=>messages.push(message),async()=>{throw new SyntaxError("Unexpected token private parser payload");});
  try{memorySource(project.scenes[0]!).attach(session);await session.cue("highlight revenue");const error=messages.find(message=>message.type==="error");expect(error).toEqual({type:"error",message:"I could not read that visual action. Please name the object and try again."});}finally{session.close();}
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
    memorySource(project.scenes[0]!).attach(session);
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

describe("Nemotron-authored lessons", () => {
  const board = project.scenes.find((scene) => scene.layout === "whiteboard") ?? project.scenes[0]!;
  const authorProposal = {
    type: "author_lesson" as const,
    prompt: "Explain how DNS resolution works",
    reason: "Teaching request",
    served: { provider: "nebius-token-factory" as const, tier: "reasoning" as const, router: { model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", tier: "fast" as const, intent: "lesson", latencyMs: 400 } },
  };
  const sequence = {
    id: "lesson-test",
    domain: "nemotron.lesson",
    steps: [
      { id: "s0", type: "insert" as const, objects: [{ id: "lesson-test-a", kind: "node" as const, label: "Browser", x: board.objects.length ? 4000 : 40, y: 4000, width: 300, height: 120 }], entrance: "draw" as const, durationMs: 900 },
      { id: "s1", type: "attention" as const, targets: ["lesson-test-a"], style: "point" as const, durationMs: 1500 },
    ],
  };
  it("plans through the reasoning tier and dispatches a validated sequence that records both models", async () => {
    const messages: ServerMessage[] = [];
    const author = vi.fn().mockResolvedValue({ type: "sequence", sequence, reason: "Drawing DNS", served: { provider: "nebius-token-factory", model: "nvidia/Nemotron-3-Ultra-550b-a55b", tier: "reasoning", planner: "nemotron.lesson", latencyMs: 3200 } });
    const s = new VisualSession((m) => messages.push(m), async () => authorProposal, undefined, undefined, author);
    memorySource(board).attach(s);
    await s.cue("Explain how DNS resolution works");
    expect(messages.some((m) => m.type === "state" && m.state === "planning")).toBe(true);
    const [action] = actions(messages);
    expect(action?.action.type).toBe("sequence");
    expect(action?.action.sequence?.id).toBe("lesson-test");
    expect(action?.action.served).toMatchObject({ provider: "nebius-token-factory", model: "nvidia/Nemotron-3-Ultra-550b-a55b", tier: "reasoning", router: { intent: "lesson" } });
    expect(author.mock.calls[0]![0]).toMatchObject({ prompt: "Explain how DNS resolution works", scene: board });
    s.close();
  });
  it("never authors from partial speech and explains when the reasoning tier is not configured", async () => {
    const messages: ServerMessage[] = [];
    const resolver = vi.fn().mockResolvedValue(authorProposal);
    const s = new VisualSession((m) => messages.push(m), resolver);
    memorySource(board).attach(s);
    await s.cue("Explain how DNS resolution works", false, true);
    expect(actions(messages)).toHaveLength(0);
    expect(messages.filter((m) => m.type === "skipped")).toHaveLength(0);
    expect(resolver.mock.calls[0]![0].final).toBe(false);
    await s.cue("Explain how DNS resolution works");
    const skipped = messages.find((m) => m.type === "skipped");
    expect(skipped && skipped.type === "skipped" && skipped.reason).toContain("reasoning tier");
    expect(actions(messages)).toHaveLength(0);
    s.close();
  });
  it("surfaces authoring failures as bounded errors without fabricating a sequence", async () => {
    const messages: ServerMessage[] = [];
    const s = new VisualSession((m) => messages.push(m), async () => authorProposal, undefined, undefined, async () => { throw new ModelResponseError("The lesson plan was cut short. Ask for a narrower topic."); });
    memorySource(board).attach(s);
    await s.cue("Explain everything about networking");
    expect(actions(messages)).toHaveLength(0);
    expect(messages.find((m) => m.type === "error")).toMatchObject({ message: "The lesson plan was cut short. Ask for a narrower topic." });
    s.close();
  });
});

describe("project source sync", () => {
  const marketing = project.scenes[0]!;
  const without = (scene: typeof marketing, id: string) => ({
    ...scene,
    objects: scene.objects.filter((object) => object.id !== id),
    connections: scene.connections.filter(
      (connection) => connection.source !== id && connection.target !== id,
    ),
  });
  const stateOf = (messages: ServerMessage[], cueId: string) =>
    messages.filter((m) => m.type === "state" && m.cueId === cueId).map((m) => m.type === "state" && m.state);
  const deferred = () => {
    let release!: (value: Awaited<ReturnType<typeof localResolve>>) => void;
    let signal!: AbortSignal;
    const resolver = vi.fn(
      (input: { signal: AbortSignal }) =>
        new Promise<Awaited<ReturnType<typeof localResolve>>>((resolve) => {
          signal = input.signal;
          release = resolve;
        }),
    );
    return { resolver, release: (value: Awaited<ReturnType<typeof localResolve>>) => release(value), signal: () => signal };
  };

  it("a peer edit invalidates only the dispatched actor whose target vanished, without aborting pending interpretation", async () => {
    const messages: ServerMessage[] = [];
    const pending = deferred();
    const resolver = vi
      .fn()
      .mockResolvedValueOnce({ type: "point", targetId: "revenue", reason: "Named revenue" })
      .mockResolvedValueOnce({ type: "point", targetId: "acquisition", reason: "Named cost" })
      .mockImplementationOnce(pending.resolver);
    const s = new VisualSession((m) => messages.push(m), resolver);
    try {
      const src = memorySource(marketing);
      src.attach(s);
      await s.cue("point to revenue");
      await s.cue("point to acquisition cost");
      const [revenue, acquisition] = actions(messages).map((m) => m.action);
      const task = s.cue("highlight acquisition cost");
      await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(3));
      const generation = (s as unknown as { generation: number }).generation;
      src.set(without(marketing, "revenue"));
      s.sync("peer");
      expect(stateOf(messages, revenue!.id)).toContain("invalidated");
      expect(stateOf(messages, acquisition!.id)).not.toContain("invalidated");
      expect((s as unknown as { generation: number }).generation).toBe(generation);
      expect(pending.signal().aborted).toBe(false);
      pending.release({ type: "highlight", targetId: "acquisition", reason: "Named cost" });
      await task;
      expect(actions(messages)).toHaveLength(3);
      expect(actions(messages)[2]!.action.revision).toBe(2);
      s.applied(acquisition!.id);
      expect(stateOf(messages, acquisition!.id)).toContain("applied");
    } finally {
      s.close();
    }
  });

  it("skips a pending cue whose target a peer deletes before dispatch", async () => {
    const messages: ServerMessage[] = [];
    const pending = deferred();
    const s = new VisualSession((m) => messages.push(m), pending.resolver);
    try {
      const src = memorySource(marketing);
      src.attach(s);
      const task = s.cue("highlight revenue");
      await vi.waitFor(() => expect(pending.resolver).toHaveBeenCalled());
      src.set(without(marketing, "revenue"));
      s.sync("peer");
      pending.release({ type: "highlight", targetId: "revenue", reason: "Named revenue" });
      await task;
      expect(actions(messages)).toHaveLength(0);
      expect(messages).toContainEqual({
        type: "skipped",
        reason: "The scene changed while I was interpreting that; say it again.",
      });
    } finally {
      s.close();
    }
  });

  it("dispatches against the live scene when a peer edit leaves the target intact", async () => {
    const messages: ServerMessage[] = [];
    const pending = deferred();
    const s = new VisualSession((m) => messages.push(m), pending.resolver);
    try {
      const src = memorySource(marketing);
      src.attach(s);
      const task = s.cue("highlight revenue");
      await vi.waitFor(() => expect(pending.resolver).toHaveBeenCalled());
      src.set({ ...marketing, title: "Renamed by a peer" });
      s.sync("peer");
      pending.release({ type: "highlight", targetId: "revenue", reason: "Named revenue" });
      await task;
      expect(actions(messages)).toHaveLength(1);
      expect(actions(messages)[0]!.action.revision).toBe(2);
    } finally {
      s.close();
    }
  });

  it("view to another scene fully invalidates, and unknown scene IDs fall back to the first scene", async () => {
    const messages: ServerMessage[] = [];
    const pending = deferred();
    const resolver = vi
      .fn()
      .mockResolvedValueOnce({ type: "point", targetId: "revenue", reason: "Named revenue" })
      .mockImplementationOnce(pending.resolver)
      .mockImplementation(async (input: Parameters<typeof localResolve>[0]) => localResolve(input));
    const s = new VisualSession((m) => messages.push(m), resolver);
    try {
      s.attach({ project, version: 1 }, project.scenes[0]!.id);
      await s.cue("point to revenue");
      const dispatched = actions(messages)[0]!.action;
      const task = s.cue("highlight revenue");
      await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2));
      s.view(project.scenes[1]!.id);
      expect(stateOf(messages, dispatched.id)).toContain("invalidated");
      expect(pending.signal().aborted).toBe(true);
      pending.release({ type: "highlight", targetId: "revenue", reason: "late" });
      await task;
      expect(actions(messages)).toHaveLength(1);
      await s.cue("highlight second row of matrix A");
      expect(actions(messages)[1]!.action).toMatchObject({ sceneId: project.scenes[1]!.id, targetId: "matrix-a:row:1" });
      s.view("no-such-scene");
      expect(stateOf(messages, actions(messages)[1]!.action.id)).toContain("invalidated");
      await s.cue("point to revenue");
      expect(actions(messages)[2]!.action.sceneId).toBe(project.scenes[0]!.id);
    } finally {
      s.close();
    }
  });

  it("clearScene skips cues until a project is attached again", async () => {
    const messages: ServerMessage[] = [];
    const s = new VisualSession((m) => messages.push(m));
    try {
      memorySource(marketing).attach(s);
      s.clearScene();
      await s.cue("point to revenue");
      expect(messages).toContainEqual({ type: "skipped", reason: "Choose a scene before giving a cue." });
      memorySource(marketing).attach(s);
      await s.cue("point to revenue");
      expect(actions(messages)).toHaveLength(1);
    } finally {
      s.close();
    }
  });

  describe("sequence ownership", () => {
    const board = marketing;
    const sequence = {
      id: "owned-lesson",
      domain: "nemotron.lesson",
      sourceIds: ["revenue"],
      steps: [
        { id: "s0", type: "insert" as const, objects: [{ id: "owned-a", kind: "node" as const, label: "Browser", x: 40, y: 400, width: 200, height: 100 }], durationMs: 300 },
        { id: "s1", type: "insert" as const, objects: [{ id: "owned-b", kind: "node" as const, label: "Resolver", x: 300, y: 400, width: 200, height: 100 }], connections: [{ id: "owned-a-b", source: "owned-a", target: "owned-b" }], durationMs: 300 },
      ],
    };
    const start = async () => {
      const messages: ServerMessage[] = [];
      const s = new VisualSession(
        (m) => messages.push(m),
        async () => ({ type: "author_lesson" as const, prompt: "Explain DNS", reason: "Teaching request" }),
        undefined,
        undefined,
        async () => ({ type: "sequence" as const, sequence, reason: "Drawing DNS" }),
      );
      const src = memorySource(board);
      src.attach(s);
      await s.cue("Explain DNS");
      const action = actions(messages)[0]!.action;
      expect(action.type).toBe("sequence");
      return { messages, s, src, action };
    };

    it("preserves the sequence acknowledgement across self commits interleaved with a peer ink stroke", async () => {
      const { messages, s, src, action } = await start();
      try {
        const first = applyPresentationStep(board, sequence.steps[0]!);
        src.set(first);
        s.sync("self");
        const inked = { ...first, ink: [{ id: "peer-stroke", color: "#e11d48", width: 4, points: [10, 10, 60, 60] }] };
        src.set(inked);
        s.sync("peer");
        src.set(applyPresentationStep(inked, sequence.steps[1]!));
        s.sync("self");
        s.applied(action.id);
        s.complete(action.id);
        expect(stateOf(messages, action.id)).not.toContain("invalidated");
        expect(stateOf(messages, action.id)).toEqual(expect.arrayContaining(["applied", "completed"]));
      } finally {
        s.close();
      }
    });

    it("invalidates dispatched actors when a self commit changes an object the sequence does not own", async () => {
      const { messages, s, src, action } = await start();
      try {
        const first = applyPresentationStep(board, sequence.steps[0]!);
        src.set({
          ...first,
          objects: first.objects.map((object) =>
            object.id === "revenue" ? { ...object, label: "Edited revenue" } : object,
          ),
        });
        s.sync("self");
        expect(stateOf(messages, action.id)).toContain("invalidated");
        s.applied(action.id);
        expect(stateOf(messages, action.id)).not.toContain("applied");
      } finally {
        s.close();
      }
    });

    it("invalidates a sequence when a peer deletes an object it depends on", async () => {
      const { messages, s, src, action } = await start();
      try {
        const first = applyPresentationStep(board, sequence.steps[0]!);
        src.set(first);
        s.sync("self");
        expect(stateOf(messages, action.id)).not.toContain("invalidated");
        // owned-a did not exist at dispatch, so a peer removing it is not a dependency loss.
        src.set(without(first, "owned-a"));
        s.sync("peer");
        expect(stateOf(messages, action.id)).not.toContain("invalidated");
        // revenue is a declared source object; a peer deleting it breaks the sequence.
        src.set(without(without(first, "owned-a"), "revenue"));
        s.sync("peer");
        expect(stateOf(messages, action.id)).toContain("invalidated");
      } finally {
        s.close();
      }
    });
  });
});
