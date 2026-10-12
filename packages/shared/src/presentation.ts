import {
  SceneSchema,
  PresentationStepSchema,
  PresentationSequenceSchema,
  hasTarget,
  getSceneViewport,
  type Scene,
  type PresentationStep,
  type PresentationSequence,
} from "./index.js";
/** JSON with recursively sorted keys and `undefined` dropped, so replicas with different key order agree. */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const inner = (value as Record<string, unknown>)[key];
      if (inner !== undefined) out[key] = sortKeys(inner);
    }
    return out;
  }
  return value;
}
/** Exact serialized source snapshot: private to the project, never executable. Key order does not matter. */
export function sequenceSourceSignature(scene: Scene, ids: string[]): string {
  return stableJson(
    ids.map((id) => {
      const object = scene.objects.find((object) => object.id === id);
      if (!object) throw new Error("A sequence source object is missing.");
      return object;
    }),
  );
}
/** Signatures written before stable ordering are re-normalized so existing projects are not marked stale. */
export function sameSignature(stored: string | undefined, current: string): boolean {
  if (stored === current) return true;
  if (!stored) return false;
  try {
    return stableJson(JSON.parse(stored)) === current;
  } catch {
    return false;
  }
}
export function applyPresentationStep(
  scene: Scene,
  input: PresentationStep,
): Scene {
  const step = PresentationStepSchema.parse(input);
  let next = scene;
  switch (step.type) {
    case "insert": {
      const objects = [...scene.objects];
      for (const object of step.objects) {
        const previous = objects.find((existing) => existing.id === object.id);
        if (previous) {
          if (stableJson(previous) !== stableJson(object))
            throw new Error(
              "Sequence insertion would replace an existing object.",
            );
        } else objects.push(object);
      }
      const connections = [...scene.connections];
      for (const connection of step.connections ?? []) {
        if (
          !objects.some((object) => object.id === connection.source) ||
          !objects.some((object) => object.id === connection.target)
        )
          throw new Error("Sequence connection endpoint is missing.");
        const previous = connections.find(
          (existing) => existing.id === connection.id,
        );
        if (previous) {
          if (stableJson(previous) !== stableJson(connection))
            throw new Error("Sequence insertion would replace a connection.");
        } else connections.push(connection);
      }
      next = {
        ...scene,
        objects,
        connections,
        ...(step.lesson ? { lesson: step.lesson } : {}),
      };
      break;
    }
    case "update":
      if (
        step.objects.some(
          (object) =>
            !scene.objects.some((existing) => existing.id === object.id),
        )
      )
        throw new Error("Sequence update target is missing.");
      next = {
        ...scene,
        objects: scene.objects.map(
          (object) =>
            step.objects.find((updated) => updated.id === object.id) ?? object,
        ),
      };
      break;
    case "camera": {
      const viewport = getSceneViewport(scene);
      next = {
        ...scene,
        viewport: {
          ...viewport,
          x: viewport.x + step.dx,
          y: viewport.y + step.dy,
        },
        activeAreaId: undefined,
      };
      break;
    }
    case "reveal":
      if (!scene.objects.some((object) => object.id === step.targetId))
        throw new Error("Sequence reveal target is missing.");
      next = {
        ...scene,
        objects: scene.objects.map((object) =>
          object.id === step.targetId ? { ...object, hidden: false } : object,
        ),
      };
      break;
    case "attention":
      if (step.targets.some((target) => !hasTarget(scene, target)))
        throw new Error("Sequence attention target is missing.");
      break;
    case "context":
      if (
        step.lesson.sourceIds.some(
          (id) => !scene.objects.some((object) => object.id === id),
        )
      )
        throw new Error("Lesson source object is missing.");
      next = { ...scene, lesson: step.lesson };
      break;
    case "wait":
      break;
  }
  if (
    step.type === "update" &&
    step.entranceTargets?.some((target) => !hasTarget(next, target))
  )
    throw new Error("Sequence entrance target is missing.");
  return SceneSchema.parse(next);
}
export function validatePresentationSequence(
  scene: Scene,
  input: PresentationSequence,
): PresentationSequence {
  const sequence = PresentationSequenceSchema.parse(input);
  if (
    sequence.sourceSignature &&
    !sameSignature(
      sequence.sourceSignature,
      sequenceSourceSignature(scene, sequence.sourceIds ?? []),
    )
  )
    throw new Error("Source objects changed. Ask for the demonstration again.");
  let snapshot = scene;
  for (const step of sequence.steps)
    snapshot = applyPresentationStep(snapshot, step);
  return sequence;
}

/** Hide stale computed illustrations after a source edit; keep their IDs for undo. */
export function invalidateDerivedResults(scene: Scene): Scene {
  let stale = false;
  const objects = scene.objects.map((object) => {
    if (!object.derivedFrom) return object;
    let current: string;
    try {
      current = sequenceSourceSignature(scene, object.derivedFrom.sourceIds);
    } catch {
      current = "missing";
    }
    if (sameSignature(object.derivedFrom.sourceSignature, current)) return object;
    stale = true;
    const { math: _math, ...rest } = object;
    return { ...rest, hidden: true };
  });
  return stale
    ? {
        ...scene,
        objects,
        lesson: scene.lesson
          ? { ...scene.lesson, sourceSignature: undefined }
          : undefined,
      }
    : scene;
}
