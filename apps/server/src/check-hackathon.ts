import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { checkHackathonConfig, formatHackathonCheck } from "./hackathon.js";
config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });
const checks = checkHackathonConfig(process.env);
console.log(formatHackathonCheck(checks));
process.exitCode = checks.some((check) => check.status !== "pass") ? 1 : 0;
