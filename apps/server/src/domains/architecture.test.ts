import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  applyPresentationStep,
  createDemoProject,
  SceneSchema,
  validatePresentationSequence,
  type PresentationSequence,
  type Scene,
  type ServerMessage,
} from "@vizli/shared";
import { planDomainPresentation } from "./index.js";
import { VisualSession } from "../session.js";
import { memorySource } from "../test-support.js";

const blank = (): Scene => ({
  ...createDemoProject().scenes[2]!,
  id: "aws-session-test",
  kind: "architecture",
  layout: "whiteboard",
  objects: [],
  connections: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});
function sequence(scene: Scene, phrase: string): PresentationSequence {
  const plan = planDomainPresentation(phrase, scene);
  expect(plan?.type).toBe("sequence");
  if (plan?.type !== "sequence") throw new Error(JSON.stringify(plan));
  return plan.sequence;
}
function apply(scene: Scene, plan: PresentationSequence) {
  return plan.steps.reduce(applyPresentationStep, scene);
}
describe("incremental AWS architecture narration", () => {
  it("adds client and gateway, DNS policy, ALB, bounded EC2 capacity, and PostgreSQL stages across clauses", () => {
    let scene = blank();
    const initialIds = scene.objects.map((object) => object.id);
    for (const phrase of [
      "A client invokes the API",
      "via API Gateway",
      "Route 53 uses geographic and latency routing to choose a regional API endpoint",
      "then the regional load balancer distributes requests",
      "It spreads traffic across 5–12 EC2 nodes in an Auto Scaling group running our application API",
      "The service writes to a PostgreSQL primary writer and reads from multiple read replicas",
    ])
      scene = apply(scene, sequence(scene, phrase));

    expect(scene.objects.map((object) => object.id)).toEqual(
      expect.arrayContaining(initialIds),
    );
    const bySuffix = (suffix: string) =>
      scene.objects.find((object) => object.id.endsWith(`-${suffix}`));
    expect(bySuffix("client")).toMatchObject({ kind: "node", label: "Client" });
    expect(bySuffix("gateway")).toMatchObject({
      plugin: { id: "cloud.aws" },
      aws: { service: "apigateway" },
    });
    expect(bySuffix("route53")).toMatchObject({
      plugin: { id: "cloud.aws" },
      aws: { service: "route53" },
    });
    expect(bySuffix("routing-note")).toMatchObject({ label: "Latency/geographic DNS", text: "DNS is best effort; nearest region is not guaranteed." });
    expect(bySuffix("alb")).toMatchObject({ aws: { service: "alb" } });
    expect(bySuffix("compute")).toMatchObject({
      aws: { service: "ec2" },
      label: expect.stringContaining("5–12 nodes"),
      text: "Regional API · Auto Scaling",
    });
    expect(bySuffix("postgres-writer")).toMatchObject({
      aws: { service: "rds" },
      label: "PostgreSQL primary writer",
    });
    expect(bySuffix("read-replicas")).toMatchObject({
      aws: { service: "rds" },
      label: "Read replicas · multiple",
    });
    expect(bySuffix("read-replicas")?.label).not.toMatch(/\d/);
    expect(bySuffix("postgres-cluster")).toMatchObject({ label: "PostgreSQL cluster", text: "Writes: primary. Reads: replicas." });
    expect(scene.connections.map((edge) => [edge.source, edge.target])).toEqual(
      expect.arrayContaining([
        [bySuffix("client")!.id, bySuffix("gateway")!.id],
        [bySuffix("route53")!.id, bySuffix("gateway")!.id],
        [bySuffix("gateway")!.id, bySuffix("alb")!.id],
        [bySuffix("alb")!.id, bySuffix("compute")!.id],
        [bySuffix("compute")!.id, bySuffix("postgres-writer")!.id],
        [bySuffix("compute")!.id, bySuffix("read-replicas")!.id],
        [bySuffix("postgres-writer")!.id, bySuffix("read-replicas")!.id],
      ]),
    );
    expect(SceneSchema.safeParse(scene).success).toBe(true);
  });

  it("handles split database clauses without fabricating a replica count", () => {
    let scene = apply(blank(), sequence(blank(), "A PostgreSQL cluster"));
    scene = apply(scene, sequence(scene, "has a primary writer"));
    scene = apply(scene, sequence(scene, "and multiple read replicas"));
    expect(scene.objects.filter((object) => object.aws?.service === "rds")).toHaveLength(2);
    expect(scene.objects.find((object) => object.id.endsWith("-read-replicas"))?.label).toBe(
      "Read replicas · multiple",
    );
  });

  it("uses stable IDs, skips completed repeats, and updates an explicit capacity range", () => {
    let scene = apply(blank(), sequence(blank(), "EC2 Auto Scaling from five to ten nodes"));
    const compute = scene.objects.find((object) => object.id.endsWith("-compute"))!;
    const ids = scene.objects.map((object) => object.id);
    expect(compute.label).toContain("5–10 nodes");
    const update = planDomainPresentation("Change EC2 capacity from five to twelve nodes", scene);
    expect(update?.type).toBe("sequence");
    if (update?.type !== "sequence") throw new Error("Expected a range update");
    expect(update.sequence.steps).toContainEqual(
      expect.objectContaining({ type: "update", objects: [expect.objectContaining({ id: compute.id, label: expect.stringContaining("5–12 nodes") })] }),
    );
    scene = apply(scene, update.sequence);
    expect(scene.objects.map((object) => object.id)).toEqual(ids);
    expect(scene.objects.find((object) => object.id === compute.id)?.label).toContain("5–12 nodes");
    expect(planDomainPresentation("EC2 Auto Scaling from five to twelve nodes", scene)).toMatchObject({ type: "skip" });
  });

  it("starts below the title on a blank slide and skips occupied finite slides", () => {
    const seeded = createDemoProject().scenes[2]!;
    const blankSlide = { ...blank(), layout: "slide" as const };
    const result = apply(blankSlide, sequence(blankSlide, "A client calls the API Gateway"));
    const created = result.objects.filter((object) => object.id.startsWith("aws-"));
    expect(created.length).toBeGreaterThan(1);
    expect(created.every((object) => object.x >= 0 && object.y >= 0 && object.x + object.width <= 1200 && object.y + object.height <= 675)).toBe(true);
    expect(Math.min(...created.map((object) => object.y))).toBeGreaterThanOrEqual(180);
    expect(planDomainPresentation("A client calls the API Gateway", seeded)).toMatchObject({ type: "skip", reason: expect.stringContaining("Switch to a whiteboard") });

    const blocked = { ...blank(), layout: "slide" as const, objects: [{ id: "cover", kind: "text" as const, label: "Full slide", text: "occupied", x: 0, y: 0, width: 1200, height: 675 }] };
    expect(planDomainPresentation("A client calls the API Gateway", blocked)).toMatchObject({ type: "skip", reason: expect.stringContaining("Switch to a whiteboard") });
  });

  it("keeps the whiteboard flow inside the unobstructed screen area at normal zoom", () => {
    const scene = { ...blank(), viewport: { x: 240, y: 90, zoom: 0.75 } };
    const result = apply(scene, sequence(scene, "A client calls API Gateway through Route 53 geographic latency routing, then an ALB sends requests to 5–12 EC2 Auto Scaling nodes running the API, which writes to a PostgreSQL primary writer and reads from multiple replicas."));
    const created = result.objects.filter((object) => object.id.startsWith("aws-"));
    const left = Math.min(...created.map((object) => (object.x - scene.viewport!.x) * scene.viewport!.zoom));
    const top = Math.min(...created.map((object) => (object.y - scene.viewport!.y) * scene.viewport!.zoom));
    const right = Math.max(...created.map((object) => (object.x + object.width - scene.viewport!.x) * scene.viewport!.zoom));
    const bottom = Math.max(...created.map((object) => (object.y + object.height - scene.viewport!.y) * scene.viewport!.zoom));
    expect(left).toBeGreaterThanOrEqual(289);
    expect(right).toBeLessThanOrEqual(1171);
    expect(top).toBeGreaterThanOrEqual(114);
    expect(bottom).toBeLessThanOrEqual(581);
    expect(planDomainPresentation("A client calls the API Gateway", { ...scene, viewport: { ...scene.viewport, zoom: 1.1 } })).toMatchObject({ type: "skip", reason: expect.stringContaining("Zoom out") });
  });

  it("reframes an existing flow after the camera is panned away without moving its objects", () => {
    const initial = blank();
    const first = sequence(initial, "A client calls the API Gateway");
    const populated = apply(initial, first);
    const beforePositions = populated.objects.map(({ id, x, y }) => ({ id, x, y }));
    const panned = { ...populated, viewport: { x: -420, y: -267.5, zoom: 1 } };
    const next = sequence(panned, "Route 53 uses latency and geographic routing to choose the nearest region");
    expect(next.steps[0]).toMatchObject({ type: "camera" });
    const reframed = apply(panned, next);
    expect(reframed.objects.filter((object) => beforePositions.some((prior) => prior.id === object.id)).map(({ id, x, y }) => ({ id, x, y }))).toEqual(beforePositions);
    expect(reframed.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
    const added = reframed.objects.filter((object) => !beforePositions.some((prior) => prior.id === object.id));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((object) => object.x >= 0 && object.y >= 0)).toBe(true);
    const left = Math.min(...reframed.objects.map((object) => (object.x - reframed.viewport!.x) * reframed.viewport!.zoom));
    const top = Math.min(...reframed.objects.map((object) => (object.y - reframed.viewport!.y) * reframed.viewport!.zoom));
    const right = Math.max(...reframed.objects.map((object) => (object.x + object.width - reframed.viewport!.x) * reframed.viewport!.zoom));
    const bottom = Math.max(...reframed.objects.map((object) => (object.y + object.height - reframed.viewport!.y) * reframed.viewport!.zoom));
    expect(left).toBeGreaterThanOrEqual(289);
    expect(right).toBeLessThanOrEqual(1171);
    expect(top).toBeGreaterThanOrEqual(114);
    expect(bottom).toBeLessThanOrEqual(581);
  });

  it("does not hijack a user object that collides with a generated stage ID", () => {
    const scene = blank();
    const key = createHash("sha256").update(scene.id).digest("hex").slice(0, 12);
    const collision = { ...scene, objects: [{ id: `aws-${key}-client`, kind: "node" as const, label: "Custom client", x: 40, y: 40, width: 180, height: 100 }] };
    expect(planDomainPresentation("A client invokes the API", collision)).toMatchObject({ type: "skip", reason: expect.stringContaining("user object") });
  });

  it("updates a replica count only when the speaker supplies one", () => {
    let scene = apply(blank(), sequence(blank(), "A PostgreSQL cluster has a primary writer and multiple read replicas"));
    const before = scene.objects.find((object) => object.id.endsWith("-read-replicas"))!;
    expect(before.label).toBe("Read replicas · multiple");
    const update = planDomainPresentation("Actually make three read replicas", scene);
    expect(update?.type).toBe("sequence");
    if (update?.type !== "sequence") throw new Error("Expected explicit count update");
    scene = apply(scene, update.sequence);
    const after = scene.objects.find((object) => object.id === before.id)!;
    expect(after.label).toBe("Read replicas · 3");
    expect(after.id).toBe(before.id);
  });

  it("validates new edges atomically and preserves scene IDs and existing objects", () => {
    const prior = { ...blank(), objects: [{ id: "kept", kind: "text" as const, label: "Keep", text: "existing", x: 0, y: 0, width: 100, height: 50 }] };
    const plan = sequence(prior, "A client invokes the API via API Gateway");
    expect(() => applyPresentationStep(prior, {
      id: "bad-edge",
      type: "insert",
      objects: [],
      connections: [{ id: "bad", source: "missing", target: "kept" }],
    })).toThrow("endpoint");
    const next = apply(prior, plan);
    expect(next.id).toBe(prior.id);
    expect(next.objects.find((object) => object.id === "kept")).toEqual(prior.objects[0]);
    expect(validatePresentationSequence(prior, plan)).toEqual(plan);
  });

  it("queues finalized architecture clauses until the preceding visual sequence completes", async () => {
    const messages: ServerMessage[] = [];
    const session = new VisualSession((message) => messages.push(message));
    let scene = blank();
    const src = memorySource(scene);
    src.attach(session);
    await session.cue("A client invokes the API");
    const first = [...messages].reverse().find((message) => message.type === "action");
    expect(first?.type).toBe("action");
    if (first?.type !== "action" || !first.action.sequence) throw new Error("Missing first stage");
    await session.cue("via API Gateway");
    expect(messages.filter((message) => message.type === "action")).toHaveLength(1);

    scene = apply(scene, first.action.sequence);
    src.set(scene);
    session.sync("self");
    session.applied(first.action.id);
    session.complete(first.action.id);
    await vi.waitFor(() =>
      expect(messages.filter((message) => message.type === "action")).toHaveLength(2),
    );
    const second = messages.filter((message) => message.type === "action").at(-1)!;
    expect(second.type).toBe("action");
    if (second.type !== "action" || !second.action.sequence) throw new Error("Missing queued stage");
    scene = apply(scene, second.action.sequence);
    src.set(scene);
    session.sync("self");
    session.applied(second.action.id);
    session.complete(second.action.id);
    session.close();
  });

  it("acknowledges a committed slide snapshot when schema parsing reorders object keys", async () => {
    const slide = { ...blank(), layout: "slide" as const, viewport: undefined };
    const messages: ServerMessage[] = [];
    const session = new VisualSession((message) => messages.push(message));
    const src = memorySource(slide);
    src.attach(session);
    try {
      await session.cue("A client calls the API Gateway.");
      const action = messages.find((message) => message.type === "action")!;
      if (action.type !== "action" || !action.action.sequence) throw new Error("Missing slide sequence");
      const committed = applyPresentationStep(slide, action.action.sequence.steps[0]!);
      const schemaParsedLike = {
        ...committed,
        objects: committed.objects.map((object) =>
          Object.fromEntries(Object.entries(object).reverse()) as typeof object,
        ),
      };
      src.set(schemaParsedLike);
      session.sync("self");
      src.set(Object.fromEntries(Object.entries(schemaParsedLike).reverse()) as typeof schemaParsedLike);
      session.sync("self");
      expect(messages.filter((message) => message.type === "error")).toHaveLength(0);
      expect(messages.filter((message) => message.type === "state" && message.cueId === action.action.id && message.state === "invalidated")).toHaveLength(0);
      await session.cue("Route 53 uses latency and geographic routing to choose the nearest region.");
      expect(messages.filter((message) => message.type === "action" && message.action.type === "sequence")).toHaveLength(1);
      session.complete(action.action.id);
      await vi.waitFor(() => expect(messages.filter((message) => message.type === "action" && message.action.type === "sequence")).toHaveLength(2));
    } finally {
      session.close();
    }
  });

  it("drops queued clauses after an intervening scene edit makes them stale", async () => {
    const messages: ServerMessage[] = [];
    const session = new VisualSession((message) => messages.push(message));
    const scene = blank();
    const src = memorySource(scene);
    src.attach(session);
    await session.cue("A client invokes the API");
    const first = [...messages].reverse().find((message) => message.type === "action");
    if (first?.type !== "action" || !first.action.sequence) throw new Error("Missing first stage");
    await session.cue("via API Gateway");
    src.set({ ...scene, objects: [{ id: "manual", kind: "text", label: "Manual edit", x: 20, y: 20, width: 100, height: 50 }] });
    session.sync("self");
    session.complete(first.action.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.filter((message) => message.type === "action")).toHaveLength(1);
    session.close();
  });

  it("releases and clears the queue when a renderer explicitly cancels playback", async () => {
    const messages: ServerMessage[] = [];
    const session = new VisualSession((message) => messages.push(message));
    memorySource(blank()).attach(session);
    await session.cue("A client invokes the API");
    const first = [...messages].reverse().find((message) => message.type === "action");
    if (first?.type !== "action" || !first.action.sequence) throw new Error("Missing first stage");
    await session.cue("via API Gateway");
    session.cancel(first.action.id);
    session.complete(first.action.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.filter((message) => message.type === "action")).toHaveLength(1);
    expect(messages).not.toContainEqual(
      expect.objectContaining({ type: "state", state: "completed", cueId: first.action.id }),
    );
    session.close();
  });

  it("accepts a new stage after cancelling, switching scenes, and returning", async () => {
    const messages: ServerMessage[] = [];
    const session = new VisualSession((message) => messages.push(message));
    const board = [
      "A client calls the API Gateway.",
      "Route 53 uses latency and geographic routing to choose the nearest region.",
      "The regional API sends requests to an Application Load Balancer.",
    ].reduce((scene, phrase) => apply(scene, sequence(scene, phrase)), blank());
    const otherScene = { ...blank(), id: "other-scene", title: "Meeting brief" };
    const src = memorySource(board);
    src.attach(session);
    try {
      await session.cue("It spreads traffic across 5–12 EC2 nodes in an Auto Scaling group running our application API.");
      const computeAction = messages.find((message) => message.type === "action");
      if (computeAction?.type !== "action" || !computeAction.action.sequence) throw new Error("Missing compute stage");
      const withCompute = apply(board, computeAction.action.sequence);
      src.set(withCompute);
      session.sync("self");
      session.cancel(computeAction.action.id);
      src.set(otherScene);
      session.sync("self");
      src.set(withCompute);
      session.sync("self");

      await session.cue("The service writes to a PostgreSQL primary writer and reads from multiple read replicas.");
      const databaseAction = [...messages].reverse().find((message) => message.type === "action");
      if (databaseAction?.type !== "action" || !databaseAction.action.sequence) throw new Error("Missing database stage after scene return");
      expect(databaseAction.action.sequence.steps).toContainEqual(expect.objectContaining({ type: "insert", connections: expect.arrayContaining([expect.objectContaining({ source: expect.stringContaining("-compute"), target: expect.stringContaining("-read-replicas") })]) }));
      const finalScene = apply(withCompute, databaseAction.action.sequence);
      src.set(finalScene);
      session.sync("self");
      session.applied(databaseAction.action.id);
      session.complete(databaseAction.action.id);
      expect(messages).toContainEqual(expect.objectContaining({ type: "state", state: "completed", cueId: databaseAction.action.id }));
    } finally {
      session.close();
    }
  });
});
