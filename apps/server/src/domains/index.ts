import type { Scene } from "@vizli/shared";
import { matrixLessonPlanner } from "./math.js";
import { awsRequestFlowPlanner } from "./architecture.js";
import type { DomainPlanner, DomainPlan } from "./types.js";
/** Trusted domain adapters emit the same generic presentation sequence language. */
export const DOMAIN_PLANNERS: readonly DomainPlanner[] = [
  matrixLessonPlanner,
  awsRequestFlowPlanner,
];
export function planDomainPresentation(
  text: string,
  scene: Scene,
): DomainPlan | undefined {
  for (const planner of DOMAIN_PLANNERS) {
    const plan = planner.plan(text, scene);
    if (plan) return plan;
  }
  return undefined;
}
