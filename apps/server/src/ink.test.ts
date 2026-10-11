import { describe, it, expect } from "vitest";
import {
  addInkStroke,
  clearInk,
  createDemoProject,
  INK_MAX_STROKES,
  InkStrokeSchema,
  removeInkStroke,
  SceneSchema,
  ProjectSchema,
  type InkStroke,
} from "@vizli/shared";

const scene = createDemoProject().scenes[0];
const stroke = (id: string, points: number[] = [10, 200, 40, 230]): InkStroke => ({
  id,
  color: "#d2432f",
  width: 6,
  points,
});

describe("ink strokes", () => {
  it("validates even-length point lists, colors and limits", () => {
    expect(InkStrokeSchema.safeParse(stroke("a")).success).toBe(true);
    expect(InkStrokeSchema.safeParse(stroke("a", [1, 2, 3])).success).toBe(false);
    expect(InkStrokeSchema.safeParse({ ...stroke("a"), color: "red" }).success).toBe(false);
    expect(InkStrokeSchema.safeParse({ ...stroke("a"), width: 0 }).success).toBe(false);
    expect(InkStrokeSchema.safeParse({ ...stroke("a"), opacity: 0.45 }).success).toBe(true);
    expect(InkStrokeSchema.safeParse(stroke("a", new Array(4002).fill(1))).success).toBe(false);
  });

  it("adds, replaces, removes and clears strokes without touching objects", () => {
    const withOne = addInkStroke(scene, stroke("a"));
    expect(withOne.ink?.map((s) => s.id)).toEqual(["a"]);
    expect(withOne.objects).toBe(scene.objects);
    const replaced = addInkStroke(withOne, stroke("a", [0, 0, 5, 5]));
    expect(replaced.ink).toHaveLength(1);
    expect(replaced.ink?.[0].points).toEqual([0, 0, 5, 5]);
    const withTwo = addInkStroke(replaced, stroke("b"));
    expect(removeInkStroke(withTwo, "a").ink?.map((s) => s.id)).toEqual(["b"]);
    expect(removeInkStroke(withTwo, "missing")).toBe(withTwo);
    expect(removeInkStroke(withOne, "a").ink).toBeUndefined();
    expect(clearInk(withTwo).ink).toBeUndefined();
    expect(clearInk(scene)).toBe(scene);
  });

  it("drops the oldest strokes once the cap is reached", () => {
    let full = scene;
    for (let i = 0; i < INK_MAX_STROKES; i++) full = addInkStroke(full, stroke(`s${i}`));
    expect(full.ink).toHaveLength(INK_MAX_STROKES);
    const over = addInkStroke(full, stroke("newest"));
    expect(over.ink).toHaveLength(INK_MAX_STROKES);
    expect(over.ink?.[0].id).toBe("s1");
    expect(over.ink?.at(-1)?.id).toBe("newest");
    expect(SceneSchema.safeParse(over).success).toBe(true);
  });

  it("persists through the project schema and stays optional for older projects", () => {
    const project = createDemoProject();
    project.scenes[0] = addInkStroke(project.scenes[0], { ...stroke("a"), opacity: 0.45 });
    const parsed = ProjectSchema.parse(JSON.parse(JSON.stringify(project)));
    expect(parsed.scenes[0].ink?.[0]).toEqual({ ...stroke("a"), opacity: 0.45 });
    expect(ProjectSchema.safeParse(createDemoProject()).success).toBe(true);
    expect(SceneSchema.safeParse({ ...scene, ink: [{ ...stroke("a"), extra: 1 }] }).success).toBe(false);
  });
});
