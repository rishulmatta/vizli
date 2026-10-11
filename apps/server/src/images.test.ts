import { afterEach, describe, it, expect, vi } from "vitest";
import {
  createDemoProject,
  resolveImageAnchor,
  SceneSchema,
  type ServerMessage,
  type SceneObject,
} from "@vizli/shared";
import { localResolve, createNebiusResolver } from "./resolver.js";
import { searchCommonsImage, type ImageResult } from "./images.js";
import { VisualSession } from "./session.js";
const project = createDemoProject(),
  scene = project.scenes[0]!;
const result: ImageResult = {
  src: "https://thumb.wikimedia.org/wikipedia/commons/apple.jpg",
  pageUrl: "https://commons.wikimedia.org/wiki/File:Apple.jpg",
  attribution: "Example author",
  license: "CC BY 2.0",
};
afterEach(() => vi.unstubAllGlobals());
describe("web image retrieval and chart anchoring", () => {
  it("understands standalone image-on-axis phrases before add-node handling", async () => {
    const resolve = (text: string) => localResolve({ text, scene, cues: [] });
    expect(resolve("An apple on the x axis")).toMatchObject({
      type: "add_image",
      query: "apple",
      targetId: "channels",
    });
    expect(resolve("Add an image of an apple on the x-axis")).toMatchObject({
      type: "add_image",
      query: "apple",
    });
    vi.stubGlobal("fetch", vi.fn());
    const live = createNebiusResolver({
      key: "test",
      model: "test",
      baseUrl: "https://example.test/v1",
    });
    expect(
      await live({
        text: "An apple on the x axis",
        scene,
        cues: [],
        signal: new AbortController().signal,
      }),
    ).toMatchObject({ type: "add_image", query: "apple" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("asks for clarification with multiple charts or no chart", () => {
    const multiple = structuredClone(scene);
    multiple.objects.push({
      ...multiple.objects.find((o) => o.kind === "chart")!,
      id: "another-chart",
    });
    expect(
      localResolve({
        text: "An apple on the x axis",
        scene: multiple,
        cues: [],
      }),
    ).toMatchObject({ type: "skip" });
    expect(
      localResolve({
        text: "An apple on the x axis",
        scene: project.scenes[1]!,
        cues: [],
      }),
    ).toMatchObject({ type: "skip" });
  });
  it("retrieves only on final speech and sends a sourced editable object", async () => {
    const messages: ServerMessage[] = [],
      search = vi.fn().mockResolvedValue(result),
      session = new VisualSession((m) => messages.push(m), undefined, search);
    try {
      session.setScene(scene, 1, []);
      await session.cue("An apple on the x axis", false, true);
      expect(search).not.toHaveBeenCalled();
      await session.cue("An apple on the x axis", true, true);
      const action = messages.find((m) => m.type === "action");
      expect(action?.type === "action" && action.action.object).toMatchObject({
        kind: "image",
        anchor: { targetId: "channels", kind: "x-axis" },
        imageSource: {
          query: "apple",
          provider: "Wikimedia Commons",
          license: "CC BY 2.0",
        },
      });
      expect(
        messages.some((m) => m.type === "state" && m.state === "searching"),
      ).toBe(true);
    } finally {
      session.close();
    }
  });
  it("does not dispatch stale image retrieval after a scene change", async () => {
    const messages: ServerMessage[] = [];
    let release!: (result: ImageResult) => void;
    const search = vi.fn(
        () => new Promise<ImageResult>((resolve) => (release = resolve)),
      ),
      session = new VisualSession((m) => messages.push(m), undefined, search);
    try {
      session.setScene(scene, 1, []);
      const pending = session.cue("An apple on the x axis");
      await vi.waitFor(() => expect(search).toHaveBeenCalled());
      session.setScene(project.scenes[1]!, 2, []);
      release(result);
      await pending;
      expect(messages.some((m) => m.type === "action")).toBe(false);
    } finally {
      session.close();
    }
  });
  it("retains real provider attribution as plain text and rejects foreign image URLs", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            query: {
              pages: {
                "1": {
                  index: 1,
                  imageinfo: [
                    {
                      thumburl: result.src,
                      descriptionurl: result.pageUrl,
                      extmetadata: {
                        Artist: {
                          value:
                            '<a href="https://example.test">Example author</a>',
                        },
                        LicenseShortName: { value: "CC BY 2.0" },
                      },
                    },
                  ],
                },
              },
            },
          }),
        ),
      );
    vi.stubGlobal("fetch", fetch);
    expect(
      await searchCommonsImage("apple", new AbortController().signal),
    ).toEqual(result);
    expect(String(fetch.mock.calls[0]![0])).toContain("apple+fruit");
    fetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          query: {
            pages: {
              "1": {
                imageinfo: [
                  {
                    thumburl: "https://evil.test/apple.jpg",
                    descriptionurl: result.pageUrl,
                  },
                ],
              },
            },
          },
        }),
      ),
    );
    expect(
      await searchCommonsImage("apple", new AbortController().signal),
    ).toBeNull();
  });
  it("requires saved image anchors to reference chart objects", () => {
    const make = (targetId: string, kind: "image" | "text" = "image") => ({
      ...scene,
      objects: [
        ...scene.objects,
        {
          id: "test-image",
          kind,
          label: "Apple",
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          anchor: { targetId, kind: "x-axis" },
        },
      ],
    });
    expect(SceneSchema.safeParse(make("channels")).success).toBe(true);
    expect(SceneSchema.safeParse(make("missing")).success).toBe(false);
    expect(SceneSchema.safeParse(make("revenue")).success).toBe(false);
    expect(SceneSchema.safeParse(make("test-image")).success).toBe(false);
    expect(SceneSchema.safeParse(make("channels", "text")).success).toBe(false);
  });
  it("resolves attachment after chart movement and handles negative baselines", () => {
    const image: SceneObject = {
      id: "apple",
      kind: "image",
      label: "Apple",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      anchor: { targetId: "channels", kind: "x-axis" },
    };
    const chart = scene.objects.find((o) => o.id === "channels")!,
      resolved = resolveImageAnchor(image, scene);
    expect(resolved.x).toBe(chart.x + chart.width / 2 - 50);
    expect(resolved.y + 100).toBe(
      chart.y + 66 + Math.max(40, chart.height - 100),
    );
    const changed = structuredClone(scene);
    const c = changed.objects.find((o) => o.id === "channels")!;
    c.x += 100;
    c.data = [-2, 5];
    const moved = resolveImageAnchor(image, changed);
    expect(moved.x).toBe(resolved.x + 100);
    expect(moved.y + 100).toBe(c.y + 66 + Math.max(40, c.height - 100) / 2);
  });
});
