import type { UsageGate } from "./usage.js";
/**
 * Minimal Nebius Token Factory chat-completions client for strict JSON output.
 * Every tier in Vizli (fast router, core interpreter, reasoning lesson author,
 * scene planner) goes through the same runtime API; nothing here is cached or mocked.
 */
export type NebiusClientConfig = {
  key: string;
  baseUrl: string;
  usage?: UsageGate;
};
export type JsonCompletionRequest = {
  model: string;
  system: string;
  user: unknown;
  schemaName: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Nemotron hybrid reasoning switch; off keeps latency bounded for interactive cues. */
  thinking?: boolean;
};
export type JsonCompletion = {
  model: string;
  content: string;
  finishReason?: string;
  refusal?: unknown;
  latencyMs: number;
  usage?: { promptTokens?: number; completionTokens?: number };
};
export const isNemotron = (model: string) => /nemotron/i.test(model);
/** Nemotron thinking is controlled through the documented chat template argument. */
export function thinkingControl(model: string, thinking: boolean) {
  return isNemotron(model)
    ? { extra_body: { chat_template_kwargs: { enable_thinking: thinking } } }
    : {};
}
export function stripJsonFences(content: string) {
  return content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}
export async function completeJson(
  config: NebiusClientConfig,
  request: JsonCompletionRequest,
): Promise<JsonCompletion> {
  const release = config.usage?.acquireLLM();
  const started = Date.now();
  const timeout = AbortSignal.timeout(request.timeoutMs ?? 12000);
  try {
    const response = await fetch(
      `${config.baseUrl.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        signal: request.signal
          ? AbortSignal.any([request.signal, timeout])
          : timeout,
        headers: {
          Authorization: `Bearer ${config.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          temperature: request.temperature ?? 0,
          max_tokens: request.maxTokens,
          ...thinkingControl(request.model, request.thinking ?? false),
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.schemaName,
              strict: true,
              schema: request.schema,
            },
          },
          messages: [
            { role: "system", content: request.system },
            {
              role: "user",
              content:
                typeof request.user === "string"
                  ? request.user
                  : JSON.stringify(request.user),
            },
          ],
        }),
      },
    );
    if (!response.ok)
      throw new Error(
        `Nebius request failed (${response.status}). Check server configuration.`,
      );
    const body = (await response.json()) as {
      model?: string;
      choices?: {
        finish_reason?: string;
        message?: { content?: unknown; refusal?: unknown };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = body.choices?.[0];
    const content = choice?.message?.content;
    return {
      model: typeof body.model === "string" ? body.model : request.model,
      content: typeof content === "string" ? content : "",
      finishReason: choice?.finish_reason,
      refusal: choice?.message?.refusal,
      latencyMs: Date.now() - started,
      usage: body.usage
        ? {
            promptTokens: body.usage.prompt_tokens,
            completionTokens: body.usage.completion_tokens,
          }
        : undefined,
    };
  } finally {
    release?.();
  }
}
