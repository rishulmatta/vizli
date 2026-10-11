import { afterEach, describe, it, expect, vi } from "vitest";
import { createDemoProject } from "@vizli/shared";
import { createNebiusResolver, localResolve, normalizeModelProposal, validateProposal } from "./resolver.js";
const p = createDemoProject();
const resolver = createNebiusResolver({
  key: "test-key",
  model: "test-model",
  baseUrl: "https://example.test/v1",
});
const input = {
  text: "highlight revenue",
  scene: p.scenes[0]!,
  cues: p.cues,
  signal: new AbortController().signal,
};
afterEach(() => vi.unstubAllGlobals());
describe("live model boundary", () => {
  it("uses constrained JSON schema and normalizes null optional fields without relaxing semantic checks",async()=>{
    const mock=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:JSON.stringify({type:"highlight",targetId:"matrix-b",label:null,query:null,prompt:null,illustrationKind:null,navigation:null,dx:null,dy:null,reason:"Requested",evidence:"Matrix B"})}}]})));vi.stubGlobal("fetch",mock);
    expect(await resolver({...input,text:"Highlight Matrix B",scene:p.scenes[1]!})).toMatchObject({type:"highlight",targetId:"matrix-b"});
    const format=JSON.parse(mock.mock.calls[0]![1].body).response_format;expect(format.type).toBe("json_schema");expect(format.json_schema.strict).toBe(true);expect(format.json_schema.schema.additionalProperties).toBe(false);expect(format.json_schema.schema.required).toContain("type");
    expect(normalizeModelProposal({type:"navigate",navigation:{direction:"right",areaId:null,targetId:null,zoom:null},dx:null})).toEqual({type:"navigate",navigation:{direction:"right"}});
  });
  it("skips incomplete, tentative and unsupported calculation requests instead of misclassifying them",async()=>{
    vi.stubGlobal("fetch",vi.fn());for(const text of ["Highlight","could be a three by two metrics","transpose matrix A"]){const result=await resolver({...input,text,scene:p.scenes[1]!});expect(result.type).toBe("skip");expect(result.reason.length).toBeGreaterThan(10);}expect(fetch).not.toHaveBeenCalled();
  });
  it("does not invent a row from an ordinal matrix mention",()=>{
    const proposal={type:"highlight" as const,targetId:"matrix-a:row:0",reason:"Requested"};expect(validateProposal(proposal,p.scenes[1]!,"the 1st metrics a").type).toBe("skip");expect(validateProposal(proposal,p.scenes[1]!,"highlight the 1st row of matrix A").type).toBe("highlight");
  });
  it("accepts a missing cosmetic reason but preserves target and evidence guards",async()=>{
    const response=(targetId:string)=>new Response(JSON.stringify({choices:[{finish_reason:"stop",message:{content:JSON.stringify({type:"highlight",targetId,evidence:"Matrix B"})}}]}));
    vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(response("matrix-b")).mockResolvedValueOnce(response("missing")));
    const matrixInput={...input,text:"Highlight Matrix B",scene:p.scenes[1]!};
    expect(await resolver(matrixInput)).toMatchObject({type:"highlight",targetId:"matrix-b",reason:"Visual cue received."});
    expect((await resolver(matrixInput)).type).toBe("skip");
  });
  it("reports truncated, empty and malformed responses without raw parser errors or retries",async()=>{
    const mock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({choices:[{finish_reason:"length",message:{content:""}}]}))).mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:null}}]}))).mockResolvedValueOnce(new Response(JSON.stringify({choices:[{message:{content:"{broken"}}]})));
    vi.stubGlobal("fetch",mock);
    await expect(resolver(input)).rejects.toThrow("cut short");await expect(resolver(input)).rejects.toThrow("did not return a visual action");await expect(resolver(input)).rejects.toThrow("could not read the visual action");expect(mock).toHaveBeenCalledTimes(3);
  });
  it("requests bounded direct answers for Nemotron live cues",async()=>{
    const mock=vi.fn().mockResolvedValue(new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({type:"skip"})}}]})));vi.stubGlobal("fetch",mock);
    const fast=createNebiusResolver({key:"test",model:"nvidia/nemotron-3-super-120b-a12b",baseUrl:"https://example.test/v1"});await fast(input);
    const request=JSON.parse(mock.mock.calls[0]![1].body);expect(request.max_tokens).toBe(1024);expect(request.extra_body).toEqual({chat_template_kwargs:{enable_thinking:false}});
  });
  it("excludes image payloads from paid interpretation context", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    type: "skip",
                    reason: "No instruction",
                  }),
                },
              },
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", mock);
    const scene = structuredClone(input.scene);
    scene.objects.push({
      id: "uploaded",
      kind: "image",
      label: "Uploaded photo",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      src: "data:image/png;base64,PRIVATE_BIG_IMAGE",
      imageSource: {
        query: "photo",
        provider: "example",
        pageUrl: "https://example.test",
        attribution: "VERBOSE_METADATA",
      },
    });
    await resolver({ ...input, scene });
    const body = mock.mock.calls[0]![1].body;
    expect(body).not.toContain("PRIVATE_BIG_IMAGE");
    expect(body).not.toContain("VERBOSE_METADATA");
    expect(body).toContain("Uploaded photo");
  });
  it("rejects nonexistent targets even when model quotes valid speech", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    type: "highlight",
                    targetId: "imagined",
                    reason: "test",
                    evidence: "revenue",
                  }),
                },
              },
            ],
          }),
        ),
      ),
    );
    expect((await resolver(input)).type).toBe("skip");
  });
  it("rejects missing evidence and arbitrary output properties", async () => {
    const mock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    type: "highlight",
                    targetId: "revenue",
                    reason: "test",
                  }),
                },
              },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    type: "highlight",
                    targetId: "revenue",
                    reason: "test",
                    javascript: "alert(1)",
                  }),
                },
              },
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", mock);
    expect((await resolver(input)).type).toBe("skip");
    await expect(resolver(input)).rejects.toThrow();
  });
  it("surfaces provider HTTP failure without silently using demo", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("{}", { status: 401 })),
    );
    await expect(resolver(input)).rejects.toThrow("401");
  });
  it("skips conflicting rehearsal associations", () => {
    const cues = [
      {
        id: "a",
        sceneId: "marketing",
        phrase: "revenue",
        targetId: "revenue",
        action: "point" as const,
      },
      {
        id: "b",
        sceneId: "marketing",
        phrase: "revenue",
        targetId: "acquisition",
        action: "highlight" as const,
      },
    ];
    expect(localResolve({ ...input, cues }).type).toBe("skip");
  });
  it("rejects tentative live edits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    type: "add_node",
                    label: "Cache",
                    reason: "test",
                  }),
                },
              },
            ],
          }),
        ),
      ),
    );
    expect(
      (
        await resolver({
          ...input,
          text: "maybe add a cache",
          scene: p.scenes[2]!,
        })
      ).type,
    ).toBe("skip");
  });
});

describe("Nemotron-first routing", () => {
  const decision = (intent: string, normalizedText: string, reason = "routed") => ({ intent: intent as never, normalizedText, reason, model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", latencyMs: 350 });
  const build = (router: ReturnType<typeof vi.fn>) => createNebiusResolver({ key: "k", model: "nvidia/nemotron-3-super-120b-a12b", baseUrl: "https://example.test/v1", router: router as never });
  const matrix = { ...input, scene: p.scenes[1]! };
  it("routes every final cue through the fast tier before grounding and records both the router and the planner", async () => {
    const router = vi.fn().mockResolvedValue(decision("attention", "highlight matrix-a:row:1"));
    vi.stubGlobal("fetch", vi.fn());
    const result = await build(router)({ ...matrix, text: "highlight matrix-a:row:1", final: true });
    expect(result).toMatchObject({ type: "highlight", targetId: "matrix-a:row:1", served: { provider: "local-rules", planner: "explicit-target", router: { model: "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B", tier: "fast", intent: "attention", latencyMs: 350 } } });
    expect(router).toHaveBeenCalledTimes(1);
    expect(router.mock.calls[0]![0]).toMatchObject({ text: "highlight matrix-a:row:1", scene: matrix.scene });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("grounds a repaired transcript when the presenter's exact words match nothing", async () => {
    const router = vi.fn().mockResolvedValue(decision("motion", "pulse revenue"));
    vi.stubGlobal("fetch", vi.fn());
    const result = await build(router)({ ...input, text: "pulse revenew", final: true });
    expect(result).toMatchObject({ type: "animate", targetId: "revenue", animation: "pulse", served: { planner: "motion", router: { intent: "motion" } } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("declines tentative speech from the router without a paid core call and hands lessons to the reasoning tier", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const tentative = await build(vi.fn().mockResolvedValue(decision("tentative", "we might highlight revenue", "Hedged idea")))({ ...input, text: "I was thinking about revenue here", final: true });
    expect(tentative).toMatchObject({ type: "skip", reason: "Hedged idea", served: { planner: "intent-router" } });
    const lesson = await build(vi.fn().mockResolvedValue(decision("lesson", "Explain how DNS resolution works")))({ ...input, text: "explain how dns resolution works", final: true });
    expect(lesson).toMatchObject({ type: "author_lesson", prompt: "Explain how DNS resolution works", served: { provider: "nebius-token-factory", tier: "reasoning", router: { intent: "lesson" } } });
    const unsupported = await build(vi.fn().mockResolvedValue(decision("unsupported", "what is the capital of france", "A question, not a visual change")))({ ...input, text: "what is the capital of france", final: true });
    expect(unsupported).toMatchObject({ type: "skip", reason: "A question, not a visual change" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("still prefers deterministic lesson planners for matrix declarations after a lesson decision", async () => {
    const router = vi.fn().mockResolvedValue(decision("lesson", "There are two matrices A and B. A is three by two and B is two by three."));
    vi.stubGlobal("fetch", vi.fn());
    const board = p.scenes.find((scene) => scene.layout === "whiteboard") ?? p.scenes[0]!;
    const result = await build(router)({ ...input, scene: board, text: "There are two matrices A and B. A is three by two and B is two by three.", final: true });
    expect(result.type).toBe("sequence");
    expect(result.served).toMatchObject({ provider: "local-rules", planner: "domain-planner", router: { intent: "lesson" } });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("skips routing for partial speech and falls back to deterministic order when the router fails", async () => {
    const router = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn());
    const partial = await build(router)({ ...matrix, text: "highlight matrix-a:row:1", final: false });
    expect(router).not.toHaveBeenCalled();
    expect(partial).toMatchObject({ type: "highlight", served: { provider: "local-rules", planner: "explicit-target" } });
    expect(partial.served?.router).toBeUndefined();
    const fallback = await build(router)({ ...matrix, text: "highlight matrix-a:row:1", final: true });
    expect(router).toHaveBeenCalledTimes(1);
    expect(fallback).toMatchObject({ type: "highlight", targetId: "matrix-a:row:1" });
    expect(fallback.served?.router).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("labels core-tier actions with the model, tier, latency and the preceding router decision", async () => {
    const router = vi.fn().mockResolvedValue(decision("freeform", "Highlight Matrix B"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ type: "highlight", targetId: "matrix-b", reason: "Requested", evidence: "Matrix B" }) } }] }))));
    const result = await build(router)({ ...matrix, text: "Highlight Matrix B", final: true });
    expect(result).toMatchObject({ type: "highlight", targetId: "matrix-b", served: { provider: "nebius-token-factory", model: "nvidia/nemotron-3-super-120b-a12b", tier: "core", router: { intent: "freeform" } } });
    expect(result.served?.latencyMs).toBeGreaterThanOrEqual(0);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
