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
import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as decoding from "lib0/decoding";
import {
  ClientMessageSchema,
  ProjectSchema,
  createDemoProject,
  type ServerMessage,
} from "@vizli/shared";
import { ProjectStore } from "./store.js";
import {
  CHANNEL_AUDIO,
  CHANNEL_AWARENESS,
  CHANNEL_SYNC,
  RoomError,
  RoomRegistry,
  type DocRoom,
  type Member,
} from "./collab/rooms.js";
import { ByteBucket, CountWindow, collabLimitsFromEnv } from "./collab/limits.js";
import { VisualSession } from "./session.js";
import { createNebiusResolver } from "./resolver.js";
import { createIntentRouter } from "./intent.js";
import { createLessonAuthor } from "./lessons.js";
import { generateScene, GenerateRequestSchema } from "./generate.js";
import { NvidiaSpeech } from "./speech.js";
export const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const PROJECT_ID = /^[a-zA-Z0-9_-]{1,120}$/;
/** Temporary emphasis is shown to every collaborator; navigation and persistent actions stay with the originator. */
const SHARED_EFFECTS = new Set(["highlight", "point", "animate", "clear"]);
const MAX_BAD_FRAMES = 5;
const CreateProjectSchema = z
  .object({ project: ProjectSchema.optional(), template: z.literal("demo").optional() })
  .strict();
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
    await registry.closeAll();
  });
  const providerConfig = readProviderConfig(env);
  const configured = !!(providerConfig.nebiusKey && providerConfig.liveModel);
  const mode = configured ? ("live" as const) : ("demo" as const);
  const store = new ProjectStore(
    env.DATA_DIR ? resolve(env.DATA_DIR) : resolve(repoRoot, ".data"),
  );
  const limits = collabLimitsFromEnv(env);
  const registry = new RoomRegistry(store, limits, {
    warn: (message) => app.log.warn(message),
    info: (message) => app.log.info(message),
  });
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
    provider: configured ? "nebius-token-factory" : null,
    /** Nemotron tiers in use; model IDs only, never credentials. */
    models: configured && providerConfig.tiers ? providerConfig.tiers : null,
    routing: configured ? "nemotron-first" : "local-rules",
    collab: { rooms: registry.size },
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
  app.get<{ Params: { id: string } }>(
    "/api/projects/:id",
    async (request, reply) => {
      const { id } = request.params;
      if (!PROJECT_ID.test(id))
        return reply.code(400).send({ error: "Invalid project ID" });
      try {
        const project = await registry.readPlain(id);
        if (project) return project;
        if (id === "default") return createDemoProject();
        return reply.code(404).send({ error: "Project not found" });
      } catch (error) {
        request.log.error({ err: error }, "project read failed");
        return reply.code(500).send({
          error: "Saved project could not be read. The file was preserved.",
        });
      }
    },
  );
  app.post("/api/projects", async (request, reply) => {
    const parsed = CreateProjectSchema.safeParse(request.body ?? {});
    if (!parsed.success)
      return reply
        .code(400)
        .send({ error: "Invalid project", issues: parsed.error.issues });
    const id = `p-${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const project = {
      ...(parsed.data.project ?? createDemoProject()),
      id,
      updatedAt: new Date().toISOString(),
    };
    try {
      await registry.createProject(project);
    } catch (error) {
      if (error instanceof RoomError && error.code === "project-limit")
        return reply.code(429).send({ error: error.message });
      if (error instanceof RoomError && error.code === "project-exists")
        return reply.code(409).send({ error: error.message });
      request.log.error({ err: error }, "project create failed");
      return reply.code(500).send({ error: "Could not create the project on the server" });
    }
    return reply.code(201).send({ id });
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
        !PROJECT_ID.test(request.params.id)
      )
        return reply
          .code(400)
          .send({ error: "Project ID mismatch or invalid ID" });
      let mode: Awaited<ReturnType<RoomRegistry["importProject"]>>;
      try {
        // Imports merge into the live room (collaborators converge) or the stored document; history is kept.
        mode = await registry.importProject(parsed.data);
      } catch (error) {
        // Keep filesystem paths out of API responses; the log retains the diagnostic.
        request.log.error({ err: error }, "project save failed");
        return reply.code(500).send({ error: "Could not save the project on the server" });
      }
      return { ok: true, mode };
    },
  );
  app.get("/api/session", { websocket: true }, (socket) => {
    let room: DocRoom | undefined;
    let member: Member | undefined;
    let joining = false;
    let badFrames = 0;
    const syncBucket = new ByteBucket(
      limits.syncBytesPerSecond,
      limits.syncMaxMessageBytes,
    );
    const awarenessWindow = new CountWindow(limits.awarenessPerSecond);
    const send = (message: ServerMessage) => {
      if (room) {
        room.sendJson(socket, message);
        return;
      }
      if (socket.readyState !== 1) return;
      // Check before queuing so a stalled reader cannot grow the buffer without bound.
      if (socket.bufferedAmount > limits.maxBufferedBytes) {
        socket.close(1013, "Client is too slow");
        return;
      }
      socket.send(JSON.stringify(message));
    };
    /** Session output: everything goes to this socket; temporary emphasis is also shown to peers. */
    const sessionSend = (message: ServerMessage) => {
      send(message);
      if (
        message.type === "action" &&
        room &&
        member &&
        SHARED_EFFECTS.has(message.action.type)
      )
        room.broadcastJson(
          {
            type: "effect",
            action: message.action,
            clientId: member.clientId,
            name: member.name,
          },
          socket,
        );
    };
    const badFrame = () => {
      badFrames++;
      send({ type: "error", message: "Unreadable collaboration frame.", code: "bad-frame" });
      if (badFrames >= MAX_BAD_FRAMES) socket.close(1007, "Too many unreadable frames");
    };
    const nebius = configured
      ? { usage, key: providerConfig.nebiusKey!, baseUrl: providerConfig.baseUrl }
      : undefined;
    const resolver = nebius
      ? createNebiusResolver({
          ...nebius,
          model: providerConfig.liveModel!,
          router: createIntentRouter({ ...nebius, model: providerConfig.fastModel! }),
        })
      : undefined;
    const lessonAuthor = nebius
      ? createLessonAuthor({ ...nebius, model: providerConfig.reasoningModel! })
      : undefined;
    const session = new VisualSession(
      sessionSend,
      resolver,
      undefined,
      (request, signal) => generateScene(request, env, usage, signal),
      lessonAuthor,
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
        const data = Array.isArray(raw)
          ? Buffer.concat(raw)
          : raw instanceof ArrayBuffer
            ? Buffer.from(raw)
            : raw;
        // Frames before join (or after the room is gone) are dropped silently.
        if (!room) return;
        let channel: number;
        let body: Buffer;
        try {
          const decoder = decoding.createDecoder(data);
          channel = decoding.readVarUint(decoder);
          body = data.subarray(decoder.pos);
        } catch {
          badFrame();
          return;
        }
        if (channel === CHANNEL_SYNC) {
          if (body.byteLength > limits.syncMaxMessageBytes) {
            socket.close(1009, "Sync message too large");
            return;
          }
          if (!syncBucket.allow(body.byteLength)) {
            socket.close(1008, "Sync rate exceeded");
            return;
          }
          try {
            room.handleSync(socket, body);
          } catch {
            // RoomError("bad-frame"); never let a frame error escape the socket listener.
            badFrame();
          }
        } else if (channel === CHANNEL_AWARENESS) {
          if (!awarenessWindow.allow()) return;
          try {
            room.handleAwareness(socket, body);
          } catch {
            // RoomError("bad-frame"); never let a frame error escape the socket listener.
            badFrame();
          }
        } else if (channel === CHANNEL_AUDIO) {
          if (speech) {
            try {
              if (voiceBudget.audio(body.byteLength)) speech.audio(body);
            } catch (error) {
              voiceError(
                error instanceof Error ? error.message : "Audio upload stopped.",
              );
            }
          }
        } else badFrame();
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
        if (message.type === "join") {
          if (member || joining) {
            send({ type: "error", message: "This connection already joined a project.", code: "already-joined" });
            return;
          }
          joining = true;
          void registry
            .join(
              { projectId: message.projectId, seed: message.seed },
              {
                socket,
                clientId: message.clientId,
                userId: message.userId,
                name: message.name,
                color: message.color,
                onPlain: (origin) => session.sync(origin),
              },
            )
            .then(
              (joined) => {
                joining = false;
                if (ended) {
                  joined.leave(socket);
                  return;
                }
                // `room.join` (inside the registry) already queued sync step 1, so it precedes `joined`.
                room = joined;
                member = joined.sockets.get(socket);
                send({
                  type: "joined",
                  projectId: message.projectId,
                  docId: joined.docId,
                  version: joined.version,
                });
                session.attach(joined, message.sceneId);
              },
              (error: unknown) => {
                joining = false;
                if (error instanceof RoomError)
                  send({ type: "error", message: error.message, code: error.code });
                else {
                  app.log.warn({ err: error }, "project join failed");
                  send({ type: "error", message: "Could not open the project.", code: "join-failed" });
                }
              },
            );
          return;
        }
        if (!room) {
          send({ type: "error", message: "Join a project first.", code: "not-joined" });
          return;
        }
        if (message.type === "view")
          session.view(message.sceneId, {
            viewport: message.viewport,
            activeAreaId: message.activeAreaId,
          });
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
        else if (message.type === "animation.cancelled")
          session.cancel(message.actionId);
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
      room?.leave(socket);
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
