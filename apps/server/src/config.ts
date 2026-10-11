/** Normalize optional provider settings consistently; never log the returned secrets. */
export function readProviderConfig(env: NodeJS.ProcessEnv) {
  const nonempty = (value: string | undefined) => value?.trim() || undefined;
  const liveModel = nonempty(env.NEBIUS_MODEL);
  return {
    nebiusKey: nonempty(env.NEBIUS_API_KEY),
    nvidiaKey: nonempty(env.NVIDIA_API_KEY),
    liveModel,
    planningModel: nonempty(env.NEBIUS_PLANNING_MODEL) ?? liveModel,
    baseUrl: (
      nonempty(env.NEBIUS_BASE_URL) ?? "https://api.tokenfactory.nebius.com/v1"
    ).replace(/\/+$/, ""),
  };
}
