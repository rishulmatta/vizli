import type { Scene, PresentationSequence } from "@vizli/shared";
export type DomainPlan =
  | { type: "sequence"; sequence: PresentationSequence; reason: string }
  | { type: "skip"; reason: string };
export type DomainPlanner = {
  id: string;
  plan: (text: string, scene: Scene) => DomainPlan | undefined;
};
