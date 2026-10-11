import { afterEach, describe, it, expect, vi } from "vitest";
import { createDemoProject } from "@vizli/shared";
import { createIntentRouter, IntentJsonSchema, summarizeSceneForIntent } from "./intent.js";
const project = createDemoProject();
const scene = project.scenes[0]!;
const router = createIntentRouter({ key: "test-key", baseUrl: "https://example.test/v1", model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B" });
const reply = (body: unknown) => new Response(JSON.stringify({ model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(body) } }] }));
afterEach(() => vi.unstubAllGlobals());
describe("Nemotron intent router", () => {
  it("asks the fast tier for a strict-schema decision with thinking disabled and a compact scene summary", async () => {
    const mock = vi.fn().mockResolvedValue(reply({ intent: "attention", normalizedText: "Point to revenue", reason: "Names a visible metric" }));
    vi.stubGlobal("fetch", mock);
    const decision = await router({ text: "point to revenew", scene });
    expect(decision).toMatchObject({ intent: "attention", normalizedText: "Point to revenue", model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B" });
    expect(decision!.latencyMs).toBeGreaterThanOrEqual(0);
    const request = JSON.parse(mock.mock.calls[0]![1].body);
    expect(request.model).toBe("nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B");
    expect(request.extra_body).toEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(request.response_format).toEqual({ type: "json_schema", json_schema: { name: "vizli_intent", strict: true, schema: IntentJsonSchema } });
    expect(request.max_tokens).toBeLessThanOrEqual(300);
    const user = JSON.parse(request.messages[1].content);
    expect(user.speech).toBe("point to revenew");
    expect(user.scene.objects[0]).toEqual({ id: "revenue", kind: "metric", label: "Revenue" });
    expect(JSON.stringify(user)).not.toContain("src");
    expect(mock.mock.calls[0]![1].headers.Authorization).toBe("Bearer test-key");
  });
  it("falls back silently on provider failure, malformed output or unknown intents", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 })).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "{broken" } }] }))).mockResolvedValueOnce(reply({ intent: "dance", normalizedText: "x", reason: "y" })).mockRejectedValueOnce(new Error("network")));
    for (let i = 0; i < 4; i++) expect(await router({ text: "point to revenue", scene })).toBeUndefined();
  });
  it("keeps the presenter's words when the model returns an empty normalization and propagates the caller's abort", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(reply({ intent: "freeform", normalizedText: "   ", reason: "" })));
    expect((await router({ text: "point to revenue", scene }))!.normalizedText).toBe("point to revenue");
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))));
    const pending = router({ text: "point to revenue", scene, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
  it("summarizes scenes without image payloads and caps object count", () => {
    const big = { ...scene, objects: Array.from({ length: 80 }, (_, i) => ({ ...scene.objects[0]!, id: `o${i}`, src: "data:image/png;base64,AAA" })) };
    const summary = summarizeSceneForIntent(big);
    expect(summary.objects).toHaveLength(60);
    expect(JSON.stringify(summary)).not.toContain("base64");
  });
});
