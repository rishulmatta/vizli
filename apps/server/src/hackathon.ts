import { readProviderConfig } from "./config.js";
export type PreflightCheck = {
  name: string;
  status: "pass" | "missing" | "mismatch";
  detail: string;
};
const isNemotron = (model: string) =>
  /^nvidia\/[a-z0-9._-]*nemotron[a-z0-9._-]*$/i.test(model);
export function isTokenFactoryUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      [
        "api.tokenfactory.nebius.com",
        "api.tokenfactory.us-central1.nebius.com",
      ].includes(url.hostname) &&
      !url.port &&
      url.pathname === "/v1" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
export function checkHackathonConfig(env: NodeJS.ProcessEnv): PreflightCheck[] {
  const config = readProviderConfig(env);
  const credential = (name: string, present: boolean): PreflightCheck => ({
    name,
    status: present ? "pass" : "missing",
    detail: present
      ? "Configured; value is not displayed."
      : "Set this server-only key before live validation.",
  });
  const model = (name: string, value: string | undefined): PreflightCheck => ({
    name,
    status: !value ? "missing" : isNemotron(value) ? "pass" : "mismatch",
    detail: !value
      ? "Set a NVIDIA Nemotron model available on your Nebius account."
      : isNemotron(value)
        ? "NVIDIA namespace and Nemotron model name detected; availability is not checked."
        : "Expected a NVIDIA Nemotron model ID in the nvidia/ namespace.",
  });
  const validEndpoint = isTokenFactoryUrl(config.baseUrl);
  return [
    credential("NEBIUS_API_KEY", !!config.nebiusKey),
    credential("NVIDIA_API_KEY", !!config.nvidiaKey),
    model("NEBIUS_MODEL", config.liveModel),
    model("Effective planning model", config.planningModel),
    {
      name: "NEBIUS_BASE_URL",
      status: validEndpoint ? "pass" : "mismatch",
      detail: validEndpoint
        ? "Recognized HTTPS Nebius Token Factory /v1 endpoint."
        : "Expected https://api.tokenfactory.nebius.com/v1 or https://api.tokenfactory.us-central1.nebius.com/v1 with no credentials, query, fragment or custom port.",
    },
  ];
}
export function formatHackathonCheck(checks: PreflightCheck[]) {
  return [
    "Vizli hackathon configuration preflight",
    ...checks.map(
      (check) =>
        `[${check.status.toUpperCase()}] ${check.name}: ${check.detail}`,
    ),
    "Configuration only: live inference and submission eligibility are not verified. No network calls or paid inference were performed.",
  ].join("\n");
}
