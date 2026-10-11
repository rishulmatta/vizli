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
/** Exact serialized source snapshot: private to the project, never executable. */
export function sequenceSourceSignature(scene: Scene, ids: string[]): string {
  return JSON.stringify(
    ids.map((id) => {
      const object = scene.objects.find((object) => object.id === id);
      if (!object) throw new Error("A sequence source object is missing.");
      return object;
    }),
  );
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
          if (JSON.stringify(previous) !== JSON.stringify(object))
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
          if (JSON.stringify(previous) !== JSON.stringify(connection))
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
    sequenceSourceSignature(scene, sequence.sourceIds ?? []) !==
      sequence.sourceSignature
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
    if (current === object.derivedFrom.sourceSignature) return object;
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
