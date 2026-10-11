import { describe, it, expect, vi, afterEach } from "vitest";
import {
  createPluginObject,
  createDemoProject,
  SceneObjectSchema,
  SceneSchema,
  objectTargets,
  targetIds,
  BUILTIN_PLUGINS,
  MOTION_PRESETS,
} from "@vizli/shared";
import {
  localResolve,
  validateProposal,
  createNebiusResolver,
} from "./resolver.js";
import { VisualSession } from "./session.js";
const project = createDemoProject();
const aws = createPluginObject("cloud.aws", "aws-function", 100, 200),
  uml = createPluginObject("uml.class", "customer-class", 450, 200);
const scene = SceneSchema.parse({
  ...project.scenes[2],
  layout: "whiteboard",
  objects: [aws, uml],
  connections: [],
});
afterEach(() => vi.unstubAllGlobals());
describe("trusted built-in plugins", () => {
  it("roundtrips serializable presets and preserves legacy IDs", () => {
    for (const plugin of BUILTIN_PLUGINS)
      expect(
        SceneObjectSchema.safeParse(
          JSON.parse(
            JSON.stringify(
              createPluginObject(
                plugin.id,
                plugin.id.replaceAll(".", "-"),
                0,
                0,
              ),
            ),
          ),
        ).success,
      ).toBe(true);
    expect(targetIds(project.scenes[1]!)).toContain("matrix-a:cell:1:1");
    expect(targetIds(project.scenes[0]!)).toContain("channels:bar:2");
    expect(
      Object.values(MOTION_PRESETS).every(
        (preset) => preset.durationMs > 0 && preset.durationMs <= 2000,
      ),
    ).toBe(true);
  });
  it("rejects unknown code, versions, kind mismatch, unbounded parts and unsupported motions", () => {
    for (const object of [
      { ...aws, plugin: { id: "remote.javascript", version: 1 } },
      { ...aws, plugin: { id: "cloud.aws", version: 2 } },
      { ...aws, kind: "text" },
      { ...uml, uml: { attributes: Array(21).fill("x"), methods: [] } },
      { ...createPluginObject("math.matrix", "m", 0, 0), motion: "flow" },
      { ...aws, script: "alert(1)" },
    ])
      expect(SceneObjectSchema.safeParse(object).success).toBe(false);
  });
  it("enumerates real internal parts and grounds demo cues to them", () => {
    expect(objectTargets(uml).map((part) => part.id)).toContain(
      "customer-class:method:1",
    );
    for (const [text, targetId] of [
      ["highlight methods of Customer", "customer-class:part:methods"],
      ["highlight service of Lambda function", "aws-function:part:service"],
      ["highlight customer-class:attribute:0", "customer-class:attribute:0"],
    ])
      expect(localResolve({ text, scene, cues: [] })).toMatchObject({
        type: "highlight",
        targetId,
      });
    expect(
      validateProposal(
        {
          type: "highlight",
          targetId: "customer-class:method:90",
          reason: "test",
        },
        scene,
        "highlight Customer methods",
      ).type,
    ).toBe("skip");
  });
  it("separates drawing existing targets from creating new illustrations and supports default/explicit motion", () => {
    const math = { ...project.scenes[1]!, layout: "whiteboard" as const };
    expect(
      localResolve({ text: "draw matrix A", scene: math, cues: [] }),
    ).toMatchObject({ type: "animate", animation: "draw" });
    expect(
      localResolve({
        text: "Animate matrix A with draw effect",
        scene: math,
        cues: [],
      }),
    ).toMatchObject({ type: "animate", animation: "draw" });
    expect(
      localResolve({ text: "draw a matrix lesson", scene: math, cues: [] })
        .type,
    ).toBe("add_illustration");
    expect(
      localResolve({ text: "flow matrix A", scene: math, cues: [] }).type,
    ).toBe("skip");
    expect(
      localResolve({
        text: "animate Lambda function",
        scene: { ...scene, objects: [{ ...aws, motion: "flow" }] },
        cues: [],
      }),
    ).toMatchObject({ animation: "flow" });
  });
  it("passes only bounded semantic capabilities to the model and dispatches motion", async () => {
    const mock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    type: "animate",
                    targetId: "customer-class:part:methods",
                    animation: "draw",
                    evidence: "Customer methods",
                    reason: "Requested",
                  }),
                },
              },
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", mock);
    const resolver = createNebiusResolver({
      key: "test",
      model: "test",
      baseUrl: "https://example.test/v1",
    });
    const result = await resolver({
      text: "Animate Customer methods with draw effect",
      scene,
      cues: [],
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ type: "animate", animation: "draw" });
    const body = JSON.parse(mock.mock.calls[0]![1].body),
      context = JSON.parse(body.messages[1].content);
    expect(context.plugins).toHaveLength(4);
    expect(context.targets).toContainEqual(
      expect.objectContaining({
        id: "customer-class:part:methods",
        plugin: "uml.class",
      }),
    );
    const messages: any[] = [];
    const session = new VisualSession((message) => messages.push(message));
    session.setScene(scene, 1, []);
    await session.cue("flow Lambda function");
    expect(messages.find((message) => message.type === "action")).toMatchObject(
      { action: { animation: "flow" } },
    );
    session.close();
  });
});
