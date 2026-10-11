import { afterEach, describe, it, expect, vi } from "vitest";
import {
  checkHackathonConfig,
  formatHackathonCheck,
  isTokenFactoryUrl,
} from "./hackathon.js";
import { readProviderConfig } from "./config.js";
import { generateScene } from "./generate.js";
const valid = {
  NEBIUS_API_KEY: "secret-nebius-sentinel",
  NVIDIA_API_KEY: "secret-nvidia-sentinel",
  NEBIUS_MODEL: "nvidia/nemotron-3-super-120b-a12b",
};
afterEach(() => vi.unstubAllGlobals());
describe("local hackathon configuration preflight", () => {
  it("checks model routing without requests or printing credentials", () => {
    vi.stubGlobal("fetch", vi.fn());
    const checks = checkHackathonConfig(valid);
    expect(checks.every((check) => check.status === "pass")).toBe(true);
    const report = formatHackathonCheck(checks);
    expect(report).not.toContain(valid.NEBIUS_API_KEY);
    expect(report).not.toContain(valid.NVIDIA_API_KEY);
    expect(report).toContain("Configuration only");
    expect(report).toContain("not verified");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("reports missing keys and wrong namespaces or model families", () => {
    const checks = checkHackathonConfig({
      ...valid,
      NEBIUS_API_KEY: "  ",
      NVIDIA_API_KEY: "",
      NEBIUS_MODEL: "meta-llama/nemotron",
      NEBIUS_PLANNING_MODEL: "nvidia/llama",
    });
    expect(checks.slice(0, 4).map((check) => check.status)).toEqual([
      "missing",
      "missing",
      "mismatch",
      "mismatch",
    ]);
  });
  it("rejects host spoofing, insecure endpoints, credentials and non-API paths", () => {
    for (const url of [
      "https://api.tokenfactory.nebius.com.evil.test/v1",
      "https://api.tokenfactory.nebius.com@evil.test/v1",
      "http://api.tokenfactory.nebius.com/v1",
      "https://secret@api.tokenfactory.nebius.com/v1",
      "https://api.tokenfactory.nebius.com/v1?key=secret",
      "https://api.tokenfactory.nebius.com/v1#fragment",
      "https://api.tokenfactory.nebius.com:8443/v1",
      "https://api.tokenfactory.nebius.com/v2",
    ])
      expect(isTokenFactoryUrl(url), url).toBe(false);
    expect(
      isTokenFactoryUrl("https://api.tokenfactory.us-central1.nebius.com/v1"),
    ).toBe(true);
  });
  it("normalizes blank optional planning model and base URL to shared defaults", () => {
    const config = readProviderConfig({
      ...valid,
      NEBIUS_PLANNING_MODEL: " ",
      NEBIUS_BASE_URL: "",
    });
    expect(config.planningModel).toBe(valid.NEBIUS_MODEL);
    expect(config.baseUrl).toBe("https://api.tokenfactory.nebius.com/v1");
    expect(
      checkHackathonConfig({
        ...valid,
        NEBIUS_PLANNING_MODEL: " ",
        NEBIUS_BASE_URL: " ",
      }).every((check) => check.status === "pass"),
    ).toBe(true);
  });
  it("uses live planning rather than silently returning demo for blank optional settings", async () => {
    const scene = {
      id: "test",
      title: "A concept",
      subtitle: "Example",
      kind: "slide",
      objects: [
        {
          id: "text",
          kind: "text",
          label: "A concept",
          text: "Example",
          x: 100,
          y: 200,
          width: 400,
          height: 100,
        },
      ],
      connections: [],
    };
    const mock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(scene) } }],
          }),
        ),
      );
    vi.stubGlobal("fetch", mock);
    const result = await generateScene(
      { prompt: "A concept", kind: "slide" },
      { ...valid, NEBIUS_PLANNING_MODEL: "", NEBIUS_BASE_URL: " " },
    );
    expect(result.source).toBe("live");
    expect(mock.mock.calls[0]![0]).toBe(
      "https://api.tokenfactory.nebius.com/v1/chat/completions",
    );
    expect(JSON.parse(mock.mock.calls[0]![1].body).model).toBe(
      valid.NEBIUS_MODEL,
    );
  });
});
