import { afterEach, describe, it, expect, vi } from "vitest";
import { SceneSchema } from "@vizli/shared";
import { buildApp } from "./app.js";
import { generateScene, GeneratedSceneSchema } from "./generate.js";
const scene = {
  id: "plan",
  title: "An example",
  subtitle: "ILLUSTRATIVE",
  kind: "slide" as const,
  objects: [
    {
      id: "headline",
      kind: "text" as const,
      label: "Concept",
      text: "Hello",
      x: 60,
      y: 220,
      width: 600,
      height: 160,
    },
  ],
  connections: [],
};
const env = {
  NODE_ENV: "test",
  NEBIUS_API_KEY: "test-key",
  NEBIUS_MODEL: "live-model",
  NEBIUS_PLANNING_MODEL: "planner-model",
};
const completion = (content: unknown) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
  );
afterEach(() => vi.unstubAllGlobals());
describe("scene planning boundary", () => {
  it("returns honest predefined templates without credentials with fresh identities", async () => {
    const a = await generateScene({ prompt: "an idea", kind: "math" }, {});
    const b = await generateScene({ prompt: "another idea", kind: "math" }, {});
    expect(a.source).toBe("demo");
    expect(a.scene.kind).toBe("math");
    expect(SceneSchema.safeParse(a.scene).success).toBe(true);
    expect(a.scene.id).not.toBe(b.scene.id);
    expect(a.scene.objects[0]!.id).not.toBe(b.scene.objects[0]!.id);
  });
  it("uses planning model and validates structured live scene", async () => {
    const fetch = vi.fn().mockResolvedValue(completion(scene));
    vi.stubGlobal("fetch", fetch);
    const result = await generateScene(
      { prompt: "A concept", kind: "slide" },
      env,
    );
    expect(result.source).toBe("live");
    expect(result.scene.title).toBe("An example");
    expect(result.scene.id).not.toBe("plan");
    expect(JSON.parse(fetch.mock.calls[0]![1].body).model).toBe(
      "planner-model",
    );
  });
  it("rejects objects overlapping reserved header or excessive object counts", () => {
    expect(
      GeneratedSceneSchema.safeParse({
        ...scene,
        objects: [{ ...scene.objects[0], y: 100 }],
      }).success,
    ).toBe(false);
    expect(
      GeneratedSceneSchema.safeParse({
        ...scene,
        objects: Array.from({ length: 31 }, (_, i) => ({
          ...scene.objects[0],
          id: `object-${i}`,
        })),
      }).success,
    ).toBe(false);
  });
  it("rejects malformed request and live output without mutating a project", async () => {
    const app = await buildApp(env);
    try {
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/scenes/generate",
            payload: { prompt: "", kind: "slide" },
          })
        ).statusCode,
      ).toBe(400);
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(completion({ ...scene, script: "execute me" })),
      );
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/scenes/generate",
            payload: { prompt: "An idea", kind: "slide" },
          })
        ).statusCode,
      ).toBe(502);
    } finally {
      await app.close();
    }
  });
});
