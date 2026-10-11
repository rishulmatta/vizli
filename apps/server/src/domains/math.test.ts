import { describe, it, expect } from "vitest";
import {
  createDemoProject,
  applyPresentationStep,
  applyObjectEdit,
  validatePresentationSequence,
  invalidateDerivedResults,
  SceneSchema,
  parseAttentionColor,
  type Scene,
  type PresentationSequence,
  type ServerMessage,
} from "@vizli/shared";
import { planDomainPresentation } from "./index.js";
import { multiplyMatrixCells } from "./math.js";
import { VisualSession } from "../session.js";
const blank = (): Scene => ({
  ...createDemoProject().scenes[2]!,
  id: "lesson-board",
  layout: "whiteboard",
  objects: [],
  connections: [],
  viewport: { x: 0, y: 0, zoom: 1 },
});
function plan(scene: Scene, text: string) {
  const result = planDomainPresentation(text, scene);
  expect(result?.type).toBe("sequence");
  if (result?.type !== "sequence") throw new Error(JSON.stringify(result));
  return result.sequence;
}
function apply(scene: Scene, sequence: PresentationSequence) {
  return sequence.steps.reduce(applyPresentationStep, scene);
}
function intro() {
  return apply(
    blank(),
    plan(blank(), "today we'll learn about matrix multiplications"),
  );
}
function declared() {
  const scene = intro();
  return apply(
    scene,
    plan(scene, "There are two metrics A and B, A is 3*2 and B is 2*3"),
  );
}
describe("reusable narrated matrix presentation", () => {
  it("creates non-destructively and preserves a lesson anchor across ASR declarations", () => {
    const original = createDemoProject().scenes[0]!;
    const scene = apply(
      { ...original, layout: "whiteboard" },
      plan(
        { ...original, layout: "whiteboard" },
        "today we will learn matrix multiplication",
      ),
    );
    expect(scene.objects.slice(0, original.objects.length)).toEqual(
      original.objects,
    );
    expect(scene.lesson!.anchor!.y).toBeGreaterThan(600);
    let state = intro();
    const first = plan(state, "A is three times two");
    state = applyPresentationStep(
      state,
      first.steps.find((step) => step.type === "insert")!,
    );
    expect(state.lesson!.sourceIds.length).toBe(2);
    state = { ...state, viewport: { x: 0, y: 280, zoom: 1 } };
    state = apply(state, plan(state, "B is two by three"));
    const matrices = state.objects.filter((object) => object.kind === "matrix");
    expect(matrices).toHaveLength(2);
    expect(matrices[0]!.y).toBe(matrices[1]!.y);
    expect(matrices[0]!.cells).toEqual([
      ["a11", "a12"],
      ["a21", "a22"],
      ["a31", "a32"],
    ]);
  });
  it("repairs the grounded merged ASR declaration boundary", () => {
    const scene = intro(),
      sequence = plan(
        scene,
        "There are two matrices, A and Ba is three by two, and B is two by three.",
      ),
      result = apply(scene, sequence);
    expect(
      result.objects.find((object) => object.value === "A")!.cells,
    ).toHaveLength(3);
    expect(
      result.objects.find((object) => object.value === "B")!.cells![0],
    ).toHaveLength(3);
  });
  it("produces all nine correct symbolic products, readable cells and animated updates", () => {
    const scene = declared(),
      sequence = plan(
        scene,
        "the rows can be multiplied with the columns of B",
      ),
      result = apply(scene, sequence);
    const product = result.objects.find(
      (object) => object.label === "Product AB",
    )!;
    expect(product.cells).toEqual([
      ["c11", "c12", "c13"],
      ["c21", "c22", "c23"],
      ["c31", "c32", "c33"],
    ]);
    expect(product.math!.expressions[2]![2]).toBe("a31 × b13 + a32 × b23");
    expect(
      sequence.steps.filter((step) => step.type === "attention"),
    ).toHaveLength(9);
    expect(
      sequence.steps.filter(
        (step) => step.type === "update" && step.entrance === "draw",
      ),
    ).toHaveLength(9);
    expect(
      planDomainPresentation(
        "the rows can be multiplied with the columns of B",
        result,
      )?.type,
    ).toBe("skip");
    expect(SceneSchema.safeParse(result).success).toBe(true);
  });
  it("computes numeric products and rejects incompatible, ambiguous or oversized work", () => {
    expect(
      multiplyMatrixCells(
        [
          [1, 2],
          [3, 4],
          [5, 6],
        ],
        [
          [7, 8, 9],
          [10, 11, 12],
        ],
      ),
    ).toEqual([
      [27, 30, 33],
      [61, 68, 75],
      [95, 106, 117],
    ]);
    expect(() => multiplyMatrixCells([[1, 2]], [[1, 2]])).toThrow("columns");
    expect(planDomainPresentation("A is 31 by 2", intro())?.type).toBe("skip");
    expect(
      planDomainPresentation("A is 3 by 2 and A is 2 by 3", intro())?.type,
    ).toBe("skip");
    expect(
      planDomainPresentation("maybe A is 3 by 2", intro()),
    ).toBeUndefined();
    // The indefinite article never declares a matrix; only "matrix a" or "a is/has" does.
    for (const text of ["Insert a 3 by 3 table", "there is a 2 by 2 grid here", "Add a 2 by 2 matrix"])
      for (const scene of [intro(), createDemoProject().scenes[0]!, createDemoProject().scenes[2]!])
        expect(planDomainPresentation(text, scene)).toBeUndefined();
    expect(planDomainPresentation("matrix a 3 by 2", intro())?.type).toBe("sequence");
    const existing = {
      ...intro(),
      objects: [...intro().objects, ...createDemoProject().scenes[1]!.objects],
    };
    expect(planDomainPresentation("A is 3 by 2", existing)?.type).toBe("skip");
  });
  it("moves pointers, blue highlights and camera using the same generic sequence steps", () => {
    const scene = declared();
    expect(plan(scene, "point to first row of A").steps).toContainEqual(
      expect.objectContaining({
        type: "attention",
        style: "point",
        targets: [`${scene.objects.find((o) => o.value === "A")!.id}:row:0`],
      }),
    );
    expect(
      plan(scene, "highlight second row of A in blue").steps,
    ).toContainEqual(
      expect.objectContaining({ type: "attention", color: "#2563eb" }),
    );
    expect(
      plan(scene, "now lets scroll down to see the multiplication").steps,
    ).toContainEqual(expect.objectContaining({ type: "camera", dy: 280 }));
  });
  it("shares explicit named and hex colors across domains without silent fallback", () => {
    expect(parseAttentionColor("highlight Lambda function in purple")).toEqual({
      color: "#9333ea",
    });
    expect(parseAttentionColor("point in #ffcc00")).toEqual({
      color: "#ffcc00",
    });
    expect(parseAttentionColor("highlight A in invisible").error).toBeTruthy();
    const scene = declared();
    expect(
      plan(scene, "highlight second row of A in cyan").steps,
    ).toContainEqual(
      expect.objectContaining({ type: "attention", color: "#0891b2" }),
    );
    expect(
      planDomainPresentation("highlight second row of A in invisible", scene)
        ?.type,
    ).toBe("skip");
  });
  it("invalidates stale derivations and rejects stale sequence sources before any mutation", () => {
    const scene = declared(),
      sequence = plan(scene, "show the multiplication one by one"),
      result = apply(scene, sequence),
      a = scene.objects.find((object) => object.value === "A")!;
    const edited = applyObjectEdit(result, a.id, {
      cell: { row: 0, col: 0, value: 7 },
    });
    expect(
      edited.objects.find((object) => object.label === "Product AB"),
    ).toMatchObject({ hidden: true });
    expect(
      edited.objects.find((object) => object.label === "Product AB")!.math,
    ).toBeUndefined();
    expect(() => validatePresentationSequence(edited, sequence)).toThrow(
      "changed",
    );
    expect(
      invalidateDerivedResults({
        ...result,
        objects: result.objects.filter((object) => object.id !== a.id),
      }).objects.find((object) => object.label === "Product AB")!.hidden,
    ).toBe(true);
  });
  it("suppresses partial creations and preserves own sequence acknowledgement across validated self-commits", async () => {
    const messages: ServerMessage[] = [];
    const session = new VisualSession((message) => messages.push(message));
    session.setScene(blank(), 1, []);
    await session.cue("today we will learn matrix multiplication", false, true);
    expect(messages.some((message) => message.type === "action")).toBe(false);
    await session.cue("today we will learn matrix multiplication", true, true);
    const action = messages.find((message) => message.type === "action");
    expect(action?.type).toBe("action");
    if (action?.type !== "action" || !action.action.sequence)
      throw new Error("missing action");
    const sequence = action.action.sequence;
    let state = blank(),
      revision = 1;
    for (const step of sequence.steps) {
      state = applyPresentationStep(state, step);
      session.setScene(state, ++revision, [], sequence.id);
    }
    session.applied(action.action.id);
    session.complete(action.action.id);
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "state", state: "completed" }),
    );
    session.close();
  });
});
