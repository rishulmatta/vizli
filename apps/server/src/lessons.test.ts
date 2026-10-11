import { afterEach, describe, it, expect, vi } from "vitest";
import { createDemoProject, applyPresentationStep, type Scene } from "@vizli/shared";
import { compileLessonPlan, createLessonAuthor, LESSON_DOMAIN, LessonPlanJsonSchema, normalizeLessonPlan, type LessonPlan } from "./lessons.js";
const project = createDemoProject();
const board: Scene = project.scenes.find((scene) => scene.layout === "whiteboard") ?? { ...project.scenes[0]!, layout: "whiteboard" };
const plan: LessonPlan = {
  title: "DNS resolution",
  steps: [
    { kind: "introduce", id: "browser", label: "Browser", text: "Asks for the address of a name." },
    { kind: "introduce", id: "resolver", label: "Recursive resolver", text: "Looks the name up on the browser's behalf." },
    { kind: "introduce", id: "root", label: "Root server", text: null },
    { kind: "connect", from: "browser", to: "resolver", label: "query" },
    { kind: "connect", from: "resolver", to: "root", label: null },
    { kind: "connect", from: "root", to: "tld", label: "refers" },
    { kind: "introduce", id: "tld", label: "TLD server", text: null },
    { kind: "connect", from: "resolver", to: "missing", label: "ignored" },
    { kind: "emphasize", targets: ["resolver", "ghost"], style: "highlight", note: "The resolver caches answers." },
    { kind: "emphasize", targets: ["ghost"], style: "point", note: null },
  ],
};
afterEach(() => vi.unstubAllGlobals());
describe("Nemotron lesson compiler", () => {
  it("compiles a plan into validated progressive inserts, connections, attention and lesson context", () => {
    const result = compileLessonPlan(board, "Explain how DNS resolution works", plan);
    expect(result.type).toBe("sequence");
    if (result.type !== "sequence") return;
    const { sequence } = result;
    expect(sequence.domain).toBe(LESSON_DOMAIN);
    const inserts = sequence.steps.filter((step) => step.type === "insert");
    expect(inserts.filter((step) => step.type === "insert" && step.objects.length)).toHaveLength(4);
    const edges = inserts.filter((step) => step.type === "insert" && step.connections?.length);
    expect(edges).toHaveLength(3);
    const tldInsert = sequence.steps.findIndex((step) => step.type === "insert" && step.objects.some((object) => object.id.endsWith("-tld")));
    const deferredEdge = sequence.steps.findIndex((step) => step.type === "insert" && step.connections?.some((connection) => connection.id.endsWith("-root-tld")));
    expect(deferredEdge).toBeGreaterThan(tldInsert);
    const attention = sequence.steps.filter((step) => step.type === "attention");
    expect(attention).toHaveLength(1);
    expect(attention[0]!.type === "attention" && attention[0]!.targets).toEqual([`${sequence.id}-resolver`]);
    expect(new Set(sequence.steps.map((step) => step.id)).size).toBe(sequence.steps.length);
    let scene = board;
    for (const step of sequence.steps) scene = applyPresentationStep(scene, step);
    expect(scene.objects.length).toBe(board.objects.length + 4);
    expect(scene.lesson?.domain).toBe(LESSON_DOMAIN);
    expect(scene.lesson?.completedCueIds).toContain(sequence.id);
    const cards = scene.objects.slice(board.objects.length);
    expect(cards.every((card) => card.kind === "node" && card.width === 300)).toBe(true);
    expect(new Set(cards.map((card) => `${card.x}:${card.y}`)).size).toBe(4);
    expect(result.reason).toContain("Nemotron on Nebius");
    const again = compileLessonPlan(scene, "explain how dns resolution works", plan);
    expect(again.type).toBe("skip");
  });
  it("skips plans that introduce nothing and bounds very long plans to sixty steps", () => {
    expect(compileLessonPlan(board, "x", { title: "Empty", steps: [{ kind: "connect", from: "a", to: "b", label: null }, { kind: "emphasize", targets: ["a"], style: "point", note: null }] }).type).toBe("skip");
    const long: LessonPlan = {
      title: "Long",
      steps: [
        ...Array.from({ length: 12 }, (_, i) => ({ kind: "introduce" as const, id: `p${i}`, label: `Part ${i}`, text: null })),
        ...Array.from({ length: 12 }, (_, i) => ({ kind: "emphasize" as const, targets: [`p${i}`], style: "point" as const, note: null })),
      ],
    };
    const result = compileLessonPlan(board, "long", long);
    expect(result.type).toBe("sequence");
    if (result.type === "sequence") expect(result.sequence.steps.length).toBeLessThanOrEqual(60);
  });
  it("normalizes the flat provider shape, drops half-filled steps and rejects invalid slugs", () => {
    const flat = { title: "T", steps: [{ kind: "introduce", id: "a", label: "A", text: "", from: "center", to: "center", targets: null, style: null, note: null }, { kind: "connect", id: null, label: "edge", text: null, from: "a", to: "a", targets: null, style: null, note: null }, { kind: "emphasize", id: null, label: null, text: null, from: null, to: null, targets: null, style: null, note: "dropped" }, { kind: "emphasize", id: null, label: null, text: null, from: null, to: null, targets: ["a"], style: "point", note: null }, { kind: "mystery" }] };
    expect(normalizeLessonPlan(flat)).toEqual({ title: "T", steps: [{ kind: "introduce", id: "a", label: "A", text: null }, { kind: "connect", from: "a", to: "a", label: "edge" }, { kind: "emphasize", targets: ["a"], style: "point", note: null }] });
    expect(LessonPlanJsonSchema.properties.steps.items.required).toContain("targets");
  });
  it("authors through the reasoning tier with strict JSON output and readable failures", async () => {
    const flat = { title: "Load balancing", steps: [{ kind: "introduce", id: "lb", label: "Load balancer", text: "Spreads requests.", from: null, to: null, targets: null, style: null, note: null }, { kind: "introduce", id: "pool", label: "Server pool", text: null, from: null, to: null, targets: null, style: null, note: null }, { kind: "connect", id: null, label: "forwards", text: null, from: "lb", to: "pool", targets: null, style: null, note: null }] };
    const mock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ model: "nvidia/Nemotron-3-Ultra-550b-a55b", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(flat) } }] })));
    vi.stubGlobal("fetch", mock);
    const author = createLessonAuthor({ key: "k", baseUrl: "https://example.test/v1", model: "nvidia/Nemotron-3-Ultra-550b-a55b" });
    const result = await author({ prompt: "Explain load balancing", scene: board });
    expect(result.type).toBe("sequence");
    expect(result.served).toMatchObject({ provider: "nebius-token-factory", model: "nvidia/Nemotron-3-Ultra-550b-a55b", tier: "reasoning", planner: LESSON_DOMAIN });
    const request = JSON.parse(mock.mock.calls[0]![1].body);
    expect(request.response_format.json_schema).toMatchObject({ name: "vizli_lesson_plan", strict: true });
    expect(request.extra_body).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(JSON.parse(request.messages[1].content).request).toBe("Explain load balancing");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{" } }] }))).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ title: "x", steps: [{ kind: "introduce", id: "Bad Slug", label: "A", text: null }] }) } }] }))));
    await expect(author({ prompt: "x", scene: board })).rejects.toThrow("cut short");
    await expect(author({ prompt: "x", scene: board })).rejects.toThrow("expected structure");
  });
});
