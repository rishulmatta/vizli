import { readProviderConfig } from "./config.js";
import {
  UsageGuard,
  UsageLimitError,
  VoiceBudget,
  limitsFromEnv,
} from "./usage.js";
import Fastify from "fastify";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ClientMessageSchema,
  ProjectSchema,
  type ServerMessage,
} from "@vizli/shared";
import { ProjectStore } from "./store.js";
import { VisualSession } from "./session.js";
import { createNebiusResolver } from "./resolver.js";
import { generateScene, GenerateRequestSchema } from "./generate.js";
import { NvidiaSpeech } from "./speech.js";
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
type SpeechConnection = Pick<NvidiaSpeech, "audio" | "close">;
type AppDependencies = {
  usage?: UsageGuard;
  createSpeech?: (
    ...args: ConstructorParameters<typeof NvidiaSpeech>
  ) => SpeechConnection;
};
export async function buildApp(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: AppDependencies = {},
) {
  const usage = dependencies.usage ?? new UsageGuard(limitsFromEnv(env));
  const createSpeech =
    dependencies.createSpeech ??
    ((...args: ConstructorParameters<typeof NvidiaSpeech>) =>
      new NvidiaSpeech(...args));
  const app = Fastify({
    logger: env.NODE_ENV !== "test",
    bodyLimit: 12 * 1024 * 1024,
  });
  const sessionCleanups = new Set<() => void>();
  app.addHook("preClose", async () => {
    for (const cleanup of sessionCleanups) cleanup();
  });
  const providerConfig = readProviderConfig(env);
  const configured = !!(providerConfig.nebiusKey && providerConfig.liveModel);
  const mode = configured ? ("live" as const) : ("demo" as const);
  const store = new ProjectStore(
    env.DATA_DIR ? resolve(env.DATA_DIR) : resolve(repoRoot, ".data"),
  );
  // Default trusted origins follow the configured API port so moving off 3001 keeps the built app usable.
  const apiPort = env.PORT?.trim() || "3001";
  const allowed = new Set(
    (
      env.ALLOWED_ORIGINS ??
      `http://localhost:5173,http://127.0.0.1:5173,http://localhost:${apiPort},http://127.0.0.1:${apiPort}`
    ).split(","),
  );
  app.addHook("onRequest", async (request, reply) => {
    // No wildcard CORS; browser mutations and upgrades require a trusted same-app origin.
    const origin = request.headers.origin;
    if (origin && !allowed.has(origin)) {
      return reply.code(403).send({ error: "Origin not allowed" });
    }
    if (
      ["PUT", "POST", "DELETE", "PATCH"].includes(request.method) &&
      request.headers["sec-fetch-site"] === "cross-site"
    )
      return reply.code(403).send({ error: "Cross-site request rejected" });
  });
  await app.register(websocket, { options: { maxPayload: 12 * 1024 * 1024 } });
  app.get("/api/status", async () => ({
    mode,
    speechConfigured: !!providerConfig.nvidiaKey,
    modelConfigured: configured,
    model: configured ? providerConfig.liveModel : null,
  }));
  app.post("/api/scenes/generate", async (request, reply) => {
    const parsed = GenerateRequestSchema.safeParse(request.body);
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Supply a prompt and supported scene kind." });
    try {
      return await generateScene(parsed.data, env, usage);
    } catch (error) {
      if (error instanceof UsageLimitError)
        return reply.code(429).send({ error: error.message });
      request.log.warn(
        { error: error instanceof Error ? error.message : "Generation failed" },
        "Scene planner rejected result",
      );
      return reply.code(502).send({
        error:
          "Could not create a valid scene. Try a simpler idea or check the planning model configuration.",
      });
    }
  });
  app.get("/api/projects/default", async (_request, reply) => {
    try {
      return await store.load("default");
    } catch {
      return reply.code(500).send({
        error: "Saved project could not be read. The file was preserved.",
      });
    }
  });
  app.put<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const parsed = ProjectSchema.safeParse(request.body);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: "Invalid project", issues: parsed.error.issues });
      if (
        parsed.data.id !== request.params.id ||
        !/^[a-zA-Z0-9_-]{1,120}$/.test(request.params.id)
      )
        return reply
          .code(400)
          .send({ error: "Project ID mismatch or invalid ID" });
      try {
        await store.save(parsed.data);
      } catch (error) {
        // Keep filesystem paths out of API responses; the log retains the diagnostic.
        request.log.error({ err: error }, "project save failed");
        return reply.code(500).send({ error: "Could not save the project on the server" });
      }
      return { ok: true };
    },
  );
  app.get("/api/session", { websocket: true }, (socket) => {
    const send = (message: ServerMessage) => {
      if (socket.readyState === 1) {
        if (socket.bufferedAmount > 1024 * 1024) {
          socket.close(1013, "Client is too slow");
          return;
        }
        socket.send(JSON.stringify(message));
      }
    };
    const resolver = configured
      ? createNebiusResolver({
          usage,
          key: providerConfig.nebiusKey!,
          model: providerConfig.liveModel!,
          baseUrl: providerConfig.baseUrl,
        })
      : undefined;
    const session = new VisualSession(
      send,
      resolver,
      undefined,
      (request, signal) => generateScene(request, env, usage, signal),
    );
    let speech: SpeechConnection | undefined;
    const voiceBudget = new VoiceBudget(usage);
    let cueTimes: number[] = [];
    let speechEpoch = 0;
    const stopVoice = () => {
      speechEpoch++;
      const previous = speech;
      speech = undefined;
      voiceBudget.stop();
      session.stopSpeech();
      previous?.close();
    };
    const voiceError = (message: string) => {
      stopVoice();
      send({ type: "error", message });
      send({ type: "speech", state: "error" });
    };
    send({ type: "ready", mode });
    socket.on("message", (raw, binary) => {
      if (binary) {
        const audio = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        if (speech) {
          try {
            if (voiceBudget.audio(audio.byteLength)) speech.audio(audio);
          } catch (error) {
            voiceError(
              error instanceof Error ? error.message : "Audio upload stopped.",
            );
          }
        }
        return;
      }
      try {
        const parsed = ClientMessageSchema.safeParse(
          JSON.parse(raw.toString()),
        );
        if (!parsed.success) {
          send({ type: "error", message: "Invalid session message." });
          return;
        }
        const message = parsed.data;
        if (message.type === "scene")
          session.setScene(
            message.scene,
            message.revision,
            message.cues,
            message.sequenceId,
          );
        else if (message.type === "cue") {
          const now = Date.now();
          cueTimes = cueTimes.filter((time) => time > now - 2000);
          if (cueTimes.length >= 10) {
            send({
              type: "skipped",
              reason: "Too many cues at once. Pause briefly and try again.",
            });
            return;
          }
          cueTimes.push(now);
          send({ type: "transcript", text: message.text, final: true });
          void session.cue(message.text);
        } else if (message.type === "applied")
          session.applied(message.actionId);
        else if (message.type === "animation.completed")
          session.complete(message.actionId);
        else if (message.type === "listen") {
          stopVoice();
          if (!message.enabled) {
            send({ type: "speech", state: "off" });
            return;
          }
          if (!providerConfig.nvidiaKey) {
            send({
              type: "error",
              message:
                "Microphone transcription requires NVIDIA_API_KEY on the server. Use a typed cue or demo cue.",
            });
            send({ type: "speech", state: "error" });
            return;
          }
          try {
            voiceBudget.start(() =>
              voiceError(
                "This session’s voice time limit was reached. Continue with typed cues.",
              ),
            );
            const epoch = speechEpoch;
            const provider = createSpeech(
              providerConfig.nvidiaKey,
              {
                endpoint: env.NVIDIA_ASR_ENDPOINT,
                functionId: env.NVIDIA_ASR_FUNCTION_ID,
                languageCode: env.NVIDIA_ASR_LANGUAGE_CODE,
              },
              {
                transcript: (t, f) => {
                  if (epoch === speechEpoch) session.speech(t, f);
                },
                state: (s) => {
                  if (epoch !== speechEpoch) return;
                  if (s !== "listening") stopVoice();
                  send({ type: "speech", state: s });
                },
                error: (message) => {
                  if (epoch === speechEpoch) send({ type: "error", message });
                },
              },
            );
            if (epoch === speechEpoch) speech = provider;
            else provider.close();
          } catch (error) {
            voiceError(
              error instanceof UsageLimitError
                ? error.message
                : "Could not start the speech connection.",
            );
          }
        }
      } catch {
        send({ type: "error", message: "Could not read the session message." });
      }
    });
    let ended = false;
    const cleanup = () => {
      if (ended) return;
      ended = true;
      sessionCleanups.delete(cleanup);
      stopVoice();
      session.close();
    };
    sessionCleanups.add(cleanup);
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
  const webRoot = resolve(repoRoot, "apps/web/dist");
  if (existsSync(webRoot)) {
    await app.register(staticFiles, { root: webRoot });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.sendFile("index.html"),
    );
  }
  return app;
}
