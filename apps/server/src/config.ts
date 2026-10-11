import type { ModelTier } from "@vizli/shared";
/**
 * Nemotron tiers on Nebius Token Factory, following the hackathon track guidance:
 * Nano for fast everyday calls, Super for core interpretation and planning,
 * Ultra when serious reasoning is needed. Every tier defaults to the core model
 * so a single NEBIUS_MODEL still runs the whole app.
 */
export type ModelTiers = Record<ModelTier, string>;
/** Normalize optional provider settings consistently; never log the returned secrets. */
export function readProviderConfig(env: NodeJS.ProcessEnv) {
  const nonempty = (value: string | undefined) => value?.trim() || undefined;
  const liveModel = nonempty(env.NEBIUS_MODEL);
  const planningModel = nonempty(env.NEBIUS_PLANNING_MODEL) ?? liveModel;
  const fastModel = nonempty(env.NEBIUS_FAST_MODEL) ?? liveModel;
  const reasoningModel = nonempty(env.NEBIUS_REASONING_MODEL) ?? planningModel;
  return {
    nebiusKey: nonempty(env.NEBIUS_API_KEY),
    nvidiaKey: nonempty(env.NVIDIA_API_KEY),
    liveModel,
    planningModel,
    fastModel,
    reasoningModel,
    tiers:
      liveModel && fastModel && reasoningModel && planningModel
        ? ({
            fast: fastModel,
            core: liveModel,
            reasoning: reasoningModel,
          } satisfies ModelTiers)
        : undefined,
    baseUrl: (
      nonempty(env.NEBIUS_BASE_URL) ?? "https://api.tokenfactory.nebius.com/v1"
    ).replace(/\/+$/, ""),
  };
}
