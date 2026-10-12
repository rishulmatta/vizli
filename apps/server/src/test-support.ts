import type { Project, Scene } from "@vizli/shared";
import type { ProjectSource, VisualSession } from "./session.js";

type Cue = Project["cues"][number];

/** Test-only in-memory project source holding a single scene. */
export function memorySource(
  scene: Scene,
  cues: Cue[] = [],
): {
  source: ProjectSource;
  set(scene: Scene, cues?: Cue[]): void;
  attach(session: VisualSession): void;
} {
  const source: { project: Project; version: number } = {
    project: {
      id: "test-project",
      title: scene.title,
      scenes: [scene],
      cues,
      updatedAt: new Date(0).toISOString(),
    },
    version: 1,
  };
  return {
    source,
    set(next, nextCues = source.project.cues) {
      source.project = { ...source.project, scenes: [next], cues: nextCues };
      source.version++;
    },
    attach(session) {
      session.attach(source, scene.id);
    },
  };
}
