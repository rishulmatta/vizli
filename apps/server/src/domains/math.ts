import { createHash } from "node:crypto";
import {
  getSceneViewport,
  parseAttentionColor,
  sequenceSourceSignature,
  validatePresentationSequence,
  applyPresentationStep,
  type Scene,
  type SceneObject,
  type PresentationStep,
  type LessonContext,
} from "@vizli/shared";
import type { DomainPlan, DomainPlanner } from "./types.js";
const domain = "math.matrix-multiplication";
const key = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 20);
const wordNumbers: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};
const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/metrics|matrices/g, "matrix")
    .replace(
      /\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g,
      (word) => String(wordNumbers[word]),
    )
    .replace(/\b(first|second|third|fourth)\b/g, (word) =>
      String(["first", "second", "third", "fourth"].indexOf(word) + 1),
    )
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/[’']/g, "");
const find = (scene: Scene, name: string) =>
  scene.objects.filter(
    (object) =>
      object.kind === "matrix" &&
      [object.value, object.label, ...(object.aliases ?? [])].some(
        (label) =>
          label?.toLowerCase() === name.toLowerCase() ||
          label?.toLowerCase() === `matrix ${name.toLowerCase()}`,
      ),
  );
function context(scene: Scene): LessonContext | undefined {
  return scene.lesson?.domain === domain ? scene.lesson : undefined;
}
function anchor(scene: Scene) {
  if (context(scene)?.anchor) return context(scene)!.anchor!;
  const view = getSceneViewport(scene);
  const near = scene.objects.filter(
    (object) =>
      object.x < view.x + 1200 &&
      object.x + object.width > view.x &&
      object.y < view.y + 1200 &&
      object.y + object.height > view.y,
  );
  return {
    x: view.x,
    y: near.length
      ? Math.max(...near.map((object) => object.y + object.height)) + 80
      : view.y,
  };
}
function cameraSteps(scene: Scene, x: number, y: number): PresentationStep[] {
  const view = getSceneViewport(scene),
    dx = x - view.x,
    dy = y - view.y;
  if (Math.abs(dx) > 2400 || Math.abs(dy) > 2400)
    throw new Error("Return closer to the lesson before continuing.");
  return dx || dy
    ? [{ id: "camera", type: "camera", dx, dy, durationMs: 650 }]
    : [];
}
function finish(
  scene: Scene,
  cue: string,
  steps: PresentationStep[],
  lesson: LessonContext,
  sourceIds: string[] = [],
): DomainPlan {
  const cueId = `math-${key(cue)}`;
  if (context(scene)?.completedCueIds.includes(cueId))
    return {
      type: "skip",
      reason: "That lesson instruction has already been applied.",
    };
  const completedCueIds = [
    ...(context(scene)?.completedCueIds ?? []),
    cueId,
  ].slice(-100);
  const finalLesson = { ...lesson, completedCueIds };
  if (!cue.startsWith("multiply:"))
    steps = steps.map((step) =>
      step.type === "insert" ? { ...step, lesson: finalLesson } : step,
    );
  steps.push({ id: "context", type: "context", lesson: finalLesson });
  const sequence = {
    id: cueId,
    domain,
    steps: steps.map((step, index) => ({ ...step, id: `${cueId}-${index}` })),
    ...(sourceIds.length
      ? {
          sourceIds,
          sourceSignature: sequenceSourceSignature(scene, sourceIds),
        }
      : {}),
  };
  return {
    type: "sequence",
    sequence: validatePresentationSequence(scene, sequence),
    reason: "Follow the narrated matrix lesson with editable, validated steps.",
  };
}
function cells(rows: number, cols: number, symbol: string) {
  return Array.from({ length: rows }, (_, r) =>
    Array.from({ length: cols }, (_, c) => `${symbol}${r + 1}${c + 1}`),
  );
}
export function multiplyMatrixCells(
  a: (number | string)[][],
  b: (number | string)[][],
): (number | string)[][] {
  if (
    !a.length ||
    !b.length ||
    a[0]!.length !== b.length ||
    a.some((row) => row.length !== a[0]!.length) ||
    b.some((row) => row.length !== b[0]!.length)
  )
    throw new Error(
      "Matrix multiplication requires columns of A to equal rows of B.",
    );
  return a.map((row) =>
    b[0]!.map((_, column) => {
      const terms = row.map(
        (value, index) => [value, b[index]![column]!] as const,
      );
      if (
        terms.every(
          ([left, right]) =>
            typeof left === "number" && typeof right === "number",
        )
      ) {
        const sum = terms.reduce(
          (total, [left, right]) =>
            total + (left as number) * (right as number),
          0,
        );
        if (!Number.isFinite(sum))
          throw new Error(
            "The numeric result exceeds supported finite values.",
          );
        return sum;
      }
      return terms.map(([left, right]) => `${left} × ${right}`).join(" + ");
    }),
  );
}
export const matrixLessonPlanner: DomainPlanner = {
  id: domain,
  plan(text, scene) {
    let n = normalized(text);
    // Riva occasionally merges the declared B name with the following A clause.
    // Repair only the explicit two-matrix introduction, never arbitrary words.
    n = n.replace(
      /(\b(?:2|two) matrix\s*,?\s*a and )ba(?=\s+is\s+\d+\s*(?:by|times|x|\*))/,
      "$1b a",
    );
    if (
      /\b(maybe|perhaps|might|could|dont|do not|not|never|wont|what if)\b/.test(
        n,
      )
    )
      return undefined;
    const lesson = context(scene),
      aPoint = anchor(scene);
    if (
      /\b(?:today|learn|teach|explain|lesson)\b/.test(n) &&
      /matrix multiplication/.test(n)
    ) {
      if (lesson)
        return {
          type: "skip",
          reason: "The matrix multiplication lesson is already ready.",
        };
      const heading: SceneObject = {
        id: `lesson-heading-${key(scene.id + String(aPoint.y))}`,
        kind: "text",
        label: "Matrix multiplication",
        text: "A row meets a column. Each dot product becomes one cell of AB.",
        x: aPoint.x + 65,
        y: aPoint.y + 60,
        width: 1040,
        height: 105,
      };
      return finish(
        scene,
        "intro",
        [
          ...cameraSteps(scene, aPoint.x, aPoint.y),
          {
            id: "heading",
            type: "insert",
            objects: [heading],
            entrance: "draw",
            durationMs: 1200,
          },
        ],
        {
          domain,
          anchor: aPoint,
          sourceIds: [heading.id],
          completedCueIds: [],
        },
      );
    }
    if (
      /^(?:please )?(make|resize|reshape|change|set|update|edit|rename)\b/.test(
        n,
      )
    )
      return undefined;
    // "matrix a 3 by 2" or "a is 3 by 2"; the bare article in "insert a 3 by 3 table" is not a declaration.
    const declarations = [
      ...n.matchAll(
        /\b(matrix\s+)?([ab])\s+(is\s+|has\s+|of\s+|=\s*)?(\d+)\s*(?:by|times|x|\*)\s*(\d+)/g,
      ),
    ]
      .filter((match) => match[1] || (match[3] && match[3].trim() !== "of"))
      .map((match) => [match[0], match[2]!, match[4]!, match[5]!] as const);
    if (declarations.length) {
      if (
        new Set(declarations.map((match) => match[1])).size !==
        declarations.length
      )
        return {
          type: "skip",
          reason: "Give one unambiguous size for each matrix.",
        };
      const steps: PresentationStep[] = [],
        newObjects: SceneObject[] = [],
        ids = [...(lesson?.sourceIds ?? [])];
      for (const declaration of declarations) {
        const name = declaration[1]!.toUpperCase(),
          rows = Number(declaration[2]),
          cols = Number(declaration[3]);
        if (rows < 1 || cols < 1 || rows > 30 || cols > 30)
          return {
            type: "skip",
            reason: "Use matrix dimensions between 1 and 30.",
          };
        const existing = find(scene, name);
        if (existing.length > 1)
          return {
            type: "skip",
            reason: `Several matrices are named ${name}. Name a unique matrix.`,
          };
        if (existing.length) {
          const object = existing[0]!;
          if (
            object.cells?.length !== rows ||
            object.cells?.[0]?.length !== cols
          )
            return {
              type: "skip",
              reason: `Matrix ${name} already exists with other dimensions. Explicitly resize it, or start a fresh whiteboard.`,
            };
          if (!ids.includes(object.id)) ids.push(object.id);
          continue;
        }
        const object: SceneObject = {
          id: `lesson-${name.toLowerCase()}-${key(scene.id + String(aPoint.y))}`,
          kind: "matrix",
          plugin: { id: "math.matrix", version: 1 },
          label: `Matrix ${name}`,
          value: name,
          aliases: [name],
          cells: cells(rows, cols, name.toLowerCase()),
          x: aPoint.x + (name === "A" ? 70 : 560),
          y: aPoint.y + 180,
          width: 380,
          height: 210,
          motion: "draw",
        };
        if (!newObjects.some((previous) => previous.id === object.id))
          newObjects.push(object);
        ids.push(object.id);
      }
      if (newObjects.length)
        steps.push(...(!lesson ? cameraSteps(scene, aPoint.x, aPoint.y) : []), {
          id: "matrices",
          type: "insert",
          objects: newObjects,
          entrance: "draw",
          durationMs: 1500,
        });
      return finish(
        scene,
        `declare:${declarations.map((match) => `${match[1]}:${match[2]}:${match[3]}`).join(",")}`,
        steps,
        {
          domain,
          anchor: aPoint,
          sourceIds: [...new Set(ids)],
          completedCueIds: lesson?.completedCueIds ?? [],
        },
      );
    }
    if (lesson && /\b(?:scroll|pan|move|go)\b/.test(n) && /\bdown\b/.test(n))
      return finish(
        scene,
        "scroll-down",
        [{ id: "scroll", type: "camera", dx: 0, dy: 280, durationMs: 700 }],
        lesson,
      );
    const row = n.match(
      /(?:\b(\d+) row|\brow (\d+))\s+(?:of\s+)?(?:matrix\s+)?([ab])\b/,
    );
    if (lesson && row && /\b(point|highlight|show)\b/.test(n)) {
      const matches = find(scene, row[3]!);
      if (matches.length !== 1)
        return {
          type: "skip",
          reason: "Name one existing matrix for that row.",
        };
      const target = matches[0]!,
        index = Number(row[1] ?? row[2]) - 1;
      if (index < 0 || index >= (target.cells?.length ?? 0))
        return { type: "skip", reason: "That row does not exist." };
      const parsedColor = parseAttentionColor(text);
      if (parsedColor.error) return { type: "skip", reason: parsedColor.error };
      const color = parsedColor.color ?? "#dc2626";
      // Attention remains a generic reusable sequence; it is replayable intentionally.
      const steps: PresentationStep[] = [
        ...(lesson ? cameraSteps(scene, aPoint.x, aPoint.y + 150) : []),
        {
          id: "attention",
          type: "attention",
          targets: [`${target.id}:row:${index}`],
          style: /highlight/.test(n) ? "highlight" : "point",
          color,
          durationMs: 1500,
        },
      ];
      return {
        type: "sequence",
        sequence: validatePresentationSequence(scene, {
          id: `attention-${key(n)}`,
          domain,
          steps,
        }),
        reason: "Follow the requested matrix row.",
      };
    }
    if (
      lesson &&
      /\b(multiply|multiplication|multiplied|product)\b/.test(n) &&
      /\b(row|rows|column|columns|one by one|demonstrate|show)\b/.test(n)
    ) {
      const as = find(scene, "A"),
        bs = find(scene, "B");
      if (as.length !== 1 || bs.length !== 1)
        return {
          type: "skip",
          reason:
            "Declare one matrix A and one matrix B before demonstrating multiplication.",
        };
      const a = as[0]!,
        b = bs[0]!;
      if (!a.cells || !b.cells)
        return { type: "skip", reason: "Both matrices need editable cells." };
      if (a.cells[0]!.length !== b.cells.length)
        return {
          type: "skip",
          reason: "Cannot multiply: columns of A must equal rows of B.",
        };
      const products = multiplyMatrixCells(a.cells, b.cells);
      if (products.length * products[0]!.length > 16 || a.cells[0]!.length > 8)
        return {
          type: "skip",
          reason:
            "The narrated demonstration supports up to 16 result cells and 8 terms per dot product.",
        };
      const signature = sequenceSourceSignature(scene, [a.id, b.id]),
        resultId = `lesson-product-${key(signature)}`,
        explanationId = `lesson-calculation-${key(signature)}`;
      const derivedFrom = {
        sourceIds: [a.id, b.id],
        sourceSignature: signature,
      };
      let result: SceneObject = {
        derivedFrom,
        id: resultId,
        kind: "matrix",
        plugin: { id: "math.matrix", version: 1 },
        label: "Product AB",
        value: "AB",
        cells: products.map((row) => row.map(() => "")),
        math: { expressions: products.map((row) => row.map(() => "")) },
        x: aPoint.x + 820,
        y: aPoint.y + 410,
        width: 310,
        height: 200,
      };
      let explanation: SceneObject = {
        derivedFrom,
        plugin: { id: "math.equation", version: 1 },
        id: explanationId,
        kind: "text",
        label: "Row × column",
        text: "$c_{ij}=\\sum_k a_{ik}b_{kj}$",
        x: aPoint.x + 70,
        y: aPoint.y + 420,
        width: 710,
        height: 150,
      };
      const steps: PresentationStep[] = [
        ...cameraSteps(scene, aPoint.x, aPoint.y + 150),
        {
          id: "result",
          type: scene.objects.some((object) => object.id === resultId)
            ? "update"
            : "insert",
          objects: [result, explanation],
          entrance: "draw",
          durationMs: 1000,
        },
      ];
      for (let r = 0; r < products.length; r++)
        for (let c = 0; c < products[r]!.length; c++) {
          steps.push({
            id: `attention-${r}-${c}`,
            type: "attention",
            targets: [`${a.id}:row:${r}`, `${b.id}:col:${c}`],
            style: "highlight",
            color: "#2563eb",
            durationMs: 1200,
          });
          const expression = a.cells[r]!.map(
            (value, k) => `${value} × ${b.cells![k]![c]}`,
          ).join(" + ");
          result = {
            ...result,
            cells: result.cells!.map((row, i) =>
              row.map((value, j) =>
                i === r && j === c
                  ? typeof products[r]![c] === "number"
                    ? products[r]![c]!
                    : `c${r + 1}${c + 1}`
                  : value,
              ),
            ),
            math: {
              expressions: result.math!.expressions.map((row, i) =>
                row.map((value, j) =>
                  i === r && j === c ? expression : value,
                ),
              ),
            },
          };
          explanation = {
            ...explanation,
            label: `AB[${r + 1}, ${c + 1}]`,
            text: `$c_{${r + 1},${c + 1}} = ${expression.replace(/\b([ab])(\d)(\d)\b/g, "$1_{$2,$3}").replace(/×/g, "\\times")}${typeof products[r]![c] === "number" ? ` = ${products[r]![c]}` : ""}$`,
          };
          steps.push(
            {
              id: `result-${r}-${c}`,
              type: "update",
              objects: [result, explanation],
              entranceTargets: [`${resultId}:cell:${r}:${c}`, explanationId],
              entrance: "draw",
              durationMs: 1000,
            },
            { id: `hold-${r}-${c}`, type: "wait", durationMs: 800 },
          );
        }
      return finish(
        scene,
        `multiply:${key(signature)}`,
        steps,
        { ...lesson, sourceSignature: signature },
        [a.id, b.id],
      );
    }
    return undefined;
  },
};
