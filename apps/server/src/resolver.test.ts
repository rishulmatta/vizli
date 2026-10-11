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
