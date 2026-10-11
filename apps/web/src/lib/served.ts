import type { ServedBy } from "@vizli/shared";
/** Short model names for the activity log; IDs stay available in the connections dialog. */
export function shortModelName(model: string): string {
  const name = model.split("/").pop() ?? model;
  const match = name.match(/nemotron[-_]?(\d(?:[._]\d)?)?[-_]?(nano|super|ultra|lightning)?/i);
  if (!match) return name;
  const version = match[1]?.replace("_", ".");
  const tier = match[2] ? match[2][0]!.toUpperCase() + match[2].slice(1).toLowerCase() : "";
  return ["Nemotron", version, tier].filter(Boolean).join(" ");
}
const seconds = (ms?: number) => (ms === undefined ? "" : ` ${(ms / 1000).toFixed(1)} s`);
/** One honest sentence about which model made the decision; never claims a model ran when rules did. */
export function describeServed(served?: ServedBy): string {
  if (!served) return "";
  const parts: string[] = [];
  if (served.router)
    parts.push(`${shortModelName(served.router.model)} routed “${served.router.intent}”${seconds(served.router.latencyMs)}`);
  if (served.provider === "nebius-token-factory" && served.model)
    parts.push(`${shortModelName(served.model)} on Nebius${served.planner ? ` · ${served.planner}` : ""}${seconds(served.latencyMs)}`);
  else if (served.planner) parts.push(`grounded by ${served.planner}`);
  return parts.join(" → ");
}
