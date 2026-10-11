import { ZodError } from "zod";
import {
  appendIllustration,
  getSceneViewport,
  applyObjectEdit,
  applyPresentationStep,
  validatePresentationSequence,
} from "@vizli/shared";
import { generateScene, type ScenePlanner } from "./generate.js";
import type { LessonAuthor } from "./lessons.js";
import { isArchitectureDomainCue } from "./domains/architecture.js";
import { createAnchoredImage, type ImageSearch } from "./images.js";
import { createActor, createMachine, type AnyActorRef } from "xstate";
import { randomUUID, createHash } from "node:crypto";
import type {
  Scene,
  Project,
  ServerMessage,
  VisualAction,
} from "@vizli/shared";
import {
  localResolve,
  normalize,
  ModelResponseError,
  type Resolver,
  type Proposal,
} from "./resolver.js";
type ResolvedActionProposal = Omit<Proposal, "type"> & {
  type: Exclude<Proposal["type"], "skip" | "author_lesson">;
};
const stableJson = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};
const sceneFingerprint = (scene: Scene) =>
  createHash("sha256").update(stableJson(scene)).digest("hex");
export const cueMachine = createMachine({
  id: "cue",
  initial: "candidate",
  states: {
    candidate: { on: { RESOLVE: "resolving", INVALIDATE: "invalidated" } },
    resolving: {
      on: {
        SEARCH: "searching",
        PLAN: "planning",
        READY: "ready",
        SKIP: "skipped",
        FAIL: "failed",
        INVALIDATE: "invalidated",
      },
    },
    searching: {
      on: {
        READY: "ready",
        SKIP: "skipped",
        FAIL: "failed",
        INVALIDATE: "invalidated",
      },
    },
    planning: {
      on: {
        READY: "ready",
        SKIP: "skipped",
        FAIL: "failed",
        INVALIDATE: "invalidated",
      },
    },
    ready: { on: { DISPATCH: "dispatched", INVALIDATE: "invalidated" } },
    dispatched: { on: { APPLIED: "applied", INVALIDATE: "invalidated" } },
    applied: { on: { COMPLETE: "completed", INVALIDATE: "invalidated" } },
    completed: { type: "final" },
    skipped: { type: "final" },
    invalidated: { type: "final" },
    failed: { type: "final" },
  },
});
export const sessionMachine = createMachine({
  id: "session",
  initial: "awaiting_scene",
  states: {
    awaiting_scene: { on: { SCENE: "ready", CLOSE: "closed" } },
    ready: { on: { SCENE: "ready", CLOSE: "closed" } },
    closed: { type: "final" },
  },
});
export class VisualSession {
  private session = createActor(sessionMachine).start();
  private scene?: Scene;
  private sequenceSnapshots = new Map<
    string,
    { actionId: string; sceneId: string; snapshots: string[]; cursor: number }
  >();
  private revision = -1;
  private cues: Project["cues"] = [];
  private abort?: AbortController;
  private generation = 0;
  private pending?: AnyActorRef;
  private actors = new Map<string, AnyActorRef>();
  private speechSeen = new Set<string>();
  /** Action IDs dispatched from partial speech in the current utterance; a revision retracts only these. */
  private speculative = new Set<string>();
  private pendingFromSpeech = false;
  private lastSpeech = "";
  private latestPartial?: string;
  private speechInFlight = false;
  /** Final architecture clauses wait for the current insertion sequence to finish, then plan against its committed snapshot. */
  private architecturePlaybackAction?: string;
  private architectureResolvingAction?: string;
  private architectureQueue: Array<{
    text: string;
    fromSpeech: boolean;
    seen: Set<string>;
  }> = [];
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private send: (m: ServerMessage) => void,
    private resolver?: Resolver,
    private imageSearch?: ImageSearch,
    private scenePlanner?: ScenePlanner,
    /** Reasoning-tier Nemotron lesson author; absent in demo mode. */
    private lessonAuthor?: LessonAuthor,
  ) {}
  setScene(
    scene: Scene,
    revision: number,
    cues: Project["cues"],
    sequenceId?: string,
  ) {
    if (revision < this.revision) {
      this.send({ type: "error", message: "Stale scene revision rejected." });
      return;
    }
    if (
      revision === this.revision &&
      this.scene &&
      stableJson(scene) !== stableJson(this.scene)
    ) {
      this.send({
        type: "error",
        message: "Scene edits must increment the revision.",
      });
      return;
    }
    if (revision !== this.revision || scene.id !== this.scene?.id) {
      const cameraOnly =
        this.scene?.id === scene.id &&
        this.scene?.layout === scene.layout &&
        stableJson(this.scene?.objects) === stableJson(scene.objects) &&
        stableJson(this.scene?.connections) === stableJson(scene.connections);
      const playback = sequenceId
        ? this.sequenceSnapshots.get(sequenceId)
        : undefined;
      const fingerprint = playback ? sceneFingerprint(scene) : undefined;
      const expectedIndex =
        playback?.sceneId === scene.id
          ? playback.snapshots.findIndex(
              (snapshot, index) =>
                index >= playback.cursor && snapshot === fingerprint,
            )
          : -1;
      if (playback && expectedIndex >= 0) playback.cursor = expectedIndex;
      if (expectedIndex < 0) {
        this.architectureQueue = [];
        this.architectureResolvingAction = undefined;
        if (!cameraOnly) this.architecturePlaybackAction = undefined;
      }
      this.invalidate(cameraOnly || expectedIndex >= 0);
      this.speechSeen.clear();
    }
    this.scene = scene;
    this.revision = revision;
    this.cues = cues;
    this.session.send({ type: "SCENE" });
    this.send({ type: "state", state: "ready" });
  }
  private invalidate(preserveDispatched = false) {
    this.generation++;
    this.abort?.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.latestPartial = undefined;
    if (this.pending?.getSnapshot().status === "active")
      this.pending.send({ type: "INVALIDATE" });
    if (!preserveDispatched) {
      for (const actor of this.actors.values())
        if (actor.getSnapshot().status === "active")
          actor.send({ type: "INVALIDATE" });
      this.actors.clear();
      this.sequenceSnapshots.clear();
      this.speculative.clear();
    }
  }
  /** Retract only speculative partial-speech effects; dispatched finals and sequences keep their acknowledgements. */
  private retractSpeculative() {
    const had = this.speculative.size > 0;
    for (const id of this.speculative) {
      const actor = this.actors.get(id);
      if (actor?.getSnapshot().status === "active")
        actor.send({ type: "INVALIDATE" });
      this.actors.delete(id);
    }
    this.speculative.clear();
    this.invalidate(true);
    return had;
  }
  stopSpeech() {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.latestPartial = undefined;
    this.lastSpeech = "";
    this.speechSeen.clear();
    this.speculative.clear();
    // Microphone lifecycle changes cancel speech-originated interpretation only; a typed cue in flight keeps running.
    if (!this.pendingFromSpeech) return;
    this.abort?.abort();
    this.generation++;
    if (this.pending?.getSnapshot().status === "active")
      this.pending.send({ type: "INVALIDATE" });
  }
  speech(text: string, final: boolean) {
    const next = normalize(text);
    if (final && !next) {
      // An empty finalized audio portion only clears speculative partial state; it never becomes a cue or a paid request.
      clearTimeout(this.timer);
      this.timer = undefined;
      this.latestPartial = undefined;
      this.lastSpeech = "";
      this.speechSeen = new Set();
      this.speculative.clear();
      return;
    }
    this.send({ type: "transcript", text, final });
    if (next === this.lastSpeech && !final) return;
    // A revised prefix retracts an attention effect from the previous speculative phrase.
    if (
      this.lastSpeech &&
      !next.startsWith(this.lastSpeech) &&
      !this.lastSpeech.startsWith(next)
    ) {
      const hadSpeculative = this.retractSpeculative();
      this.speechSeen.clear();
      if (this.scene && hadSpeculative)
        this.send({
          type: "action",
          action: {
            id: randomUUID(),
            type: "clear",
            scope: "effects",
            reason: "Speech was revised.",
            sceneId: this.scene.id,
            revision: this.revision,
          },
        });
    }
    this.lastSpeech = next;
    if (final) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.latestPartial = undefined;
      const seen = this.speechSeen;
      this.speechSeen = new Set();
      this.speculative.clear();
      void this.cue(text, true, true, seen);
      this.lastSpeech = "";
    } else {
      this.latestPartial = text;
      this.schedulePartial();
    }
  }
  private schedulePartial() {
    if (this.timer || this.speechInFlight || !this.latestPartial) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const text = this.latestPartial;
      this.latestPartial = undefined;
      if (!text) return;
      this.speechInFlight = true;
      void this.cue(text, false, true).finally(() => {
        this.speechInFlight = false;
        this.schedulePartial();
      });
    }, 320);
  }
  async cue(
    text: string,
    final = true,
    fromSpeech = false,
    seen = this.speechSeen,
  ) {
    if (!this.scene || this.session.getSnapshot().value === "closed") {
      this.send({
        type: "skipped",
        reason: "Choose a scene before giving a cue.",
      });
      return;
    }
    const architectureClause = final && isArchitectureDomainCue(text);
    if (this.architecturePlaybackAction || this.architectureResolvingAction) {
      if (architectureClause) {
        if (this.architectureQueue.length >= 20) {
          this.send({
            type: "skipped",
            reason: "The architecture lesson queue is full. Let the current stage finish, then continue.",
          });
          return;
        }
        this.architectureQueue.push({ text, fromSpeech, seen: new Set(seen) });
        return;
      }
      // A direct edit or unrelated cue changes the user’s direction. Never replay queued clauses against its newer scene.
      this.architectureQueue = [];
    }
    this.abort?.abort();
    if (this.pending?.getSnapshot().status === "active")
      this.pending.send({ type: "INVALIDATE" });
    const generation = ++this.generation,
      scene = this.scene,
      revision = this.revision,
      id = randomUUID();
    if (architectureClause) this.architectureResolvingAction = id;
    const actor = createActor(cueMachine);
    this.pending = actor;
    this.pendingFromSpeech = fromSpeech;
    actor.subscribe((s) =>
      this.send({ type: "state", state: String(s.value), cueId: id }),
    );
    actor.start();
    actor.send({ type: "RESOLVE" });
    const controller = new AbortController();
    this.abort = controller;
    let timeout = setTimeout(() => controller.abort(), 12000);
    let onAbort = () => {};
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Interpretation cancelled"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    let searching = false;
    let planning = false;
    try {
      const resolved: Proposal = await Promise.race([
        this.resolver
          ? this.resolver({
              text,
              scene,
              cues: this.cues,
              signal: controller.signal,
              final,
            })
          : Promise.resolve(localResolve({ text, scene, cues: this.cues })),
        aborted,
      ]);
      if (generation !== this.generation || controller.signal.aborted) {
        if (actor.getSnapshot().status === "active")
          actor.send({ type: "INVALIDATE" });
        return;
      }
      if (resolved.type === "skip") {
        actor.send({ type: "SKIP" });
        this.send({
          type: "skipped",
          reason: resolved.reason,
          ...(resolved.served ? { served: resolved.served } : {}),
        });
        return;
      }
      if (
        !final &&
        [
          "add_node",
          "add_image",
          "undo",
          "reveal",
          "navigate",
          "move",
          "add_illustration",
          "edit_object",
          "sequence",
          "author_lesson",
        ].includes(resolved.type)
      ) {
        actor.send({ type: "SKIP" });
        return;
      }
      let p: ResolvedActionProposal;
      if (resolved.type === "author_lesson") {
        if (!resolved.prompt) throw new Error("Describe the topic you want explained.");
        if (!this.lessonAuthor) {
          actor.send({ type: "SKIP" });
          this.send({
            type: "skipped",
            reason:
              "Lesson authoring needs the Nemotron reasoning tier on Nebius; demo mode only plays built-in lessons.",
          });
          return;
        }
        planning = true;
        actor.send({ type: "PLAN" });
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), 25000);
        const authored = await Promise.race([
          this.lessonAuthor({ prompt: resolved.prompt, scene, signal: controller.signal }),
          aborted,
        ]);
        if (generation !== this.generation || controller.signal.aborted) {
          if (actor.getSnapshot().status === "active")
            actor.send({ type: "INVALIDATE" });
          return;
        }
        const served = authored.served
          ? { ...authored.served, ...(resolved.served?.router ? { router: resolved.served.router } : {}) }
          : resolved.served;
        if (authored.type === "skip") {
          actor.send({ type: "SKIP" });
          this.send({ type: "skipped", reason: authored.reason, ...(served ? { served } : {}) });
          return;
        }
        p = { type: "sequence", sequence: authored.sequence, reason: authored.reason, served };
      } else p = resolved as ResolvedActionProposal;
      const fingerprint = `${scene.id}:${p.type}:${p.targetId ?? p.label ?? ""}:${p.query ?? p.prompt ?? ""}:${JSON.stringify(p.navigation ?? {})}:${p.dx ?? 0}:${p.dy ?? 0}:${JSON.stringify(p.patch ?? {})}:${p.animation ?? ""}:${p.color ?? ""}:${p.sequence?.id ?? ""}`;
      if (fromSpeech && seen.has(fingerprint)) {
        actor.send({ type: "SKIP" });
        return;
      }
      if (p.type === "edit_object") {
        if (!p.targetId || !p.patch)
          throw new Error("Name the object and the properties to edit.");
        applyObjectEdit(scene, p.targetId, p.patch);
      }
      if (p.type === "sequence") {
        if (!p.sequence)
          throw new Error("A presentation sequence is required.");
        validatePresentationSequence(scene, p.sequence);
        let snapshot = scene;
        const snapshots = [sceneFingerprint(snapshot)];
        for (const step of p.sequence.steps) {
          snapshot = applyPresentationStep(snapshot, step);
          snapshots.push(sceneFingerprint(snapshot));
        }
        this.sequenceSnapshots.set(p.sequence.id, {
          actionId: id,
          sceneId: scene.id,
          snapshots,
          cursor: 0,
        });
        if (this.sequenceSnapshots.size > 100)
          this.sequenceSnapshots.delete(
            this.sequenceSnapshots.keys().next().value!,
          );
      }
      let object;
      let illustration: Scene | undefined;
      let illustrationSource: "demo" | "live" | undefined;
      let illustrationServed: VisualAction["served"];
      if (p.type === "add_illustration") {
        if (!p.prompt || scene.layout !== "whiteboard") {
          actor.send({ type: "SKIP" });
          this.send({
            type: "skipped",
            reason: "Use ‘draw’ with an idea on a whiteboard.",
          });
          return;
        }
        planning = true;
        actor.send({ type: "PLAN" });
        clearTimeout(timeout);
        timeout = setTimeout(() => controller.abort(), 25000);
        const request = {
          prompt: p.prompt,
          kind: p.illustrationKind ?? ("slide" as const),
        };
        const result = await Promise.race([
          this.scenePlanner
            ? this.scenePlanner(request, controller.signal)
            : generateScene(request, {}, undefined, controller.signal),
          aborted,
        ]);
        if (generation !== this.generation || controller.signal.aborted) {
          if (actor.getSnapshot().status === "active")
            actor.send({ type: "INVALIDATE" });
          return;
        }
        illustration = appendIllustration(scene, result.scene);
        illustrationSource = result.source;
        illustrationServed = result.served
          ? { ...result.served, ...(p.served?.router ? { router: p.served.router } : {}) }
          : p.served;
      }
      if (p.type === "add_node" && scene.layout === "whiteboard") {
        const view = getSceneViewport(scene);
        object = {
          id: `node-${randomUUID()}`,
          kind: "node" as const,
          label: p.label ?? "New component",
          text: "New component",
          x: Math.min(1_000_000, view.x + 120),
          y: Math.min(1_000_000, view.y + 140),
          width: 220,
          height: 110,
          color: "#195b47",
        };
      }
      if (p.type === "add_image") {
        if (!p.query || !p.targetId) {
          actor.send({ type: "SKIP" });
          this.send({
            type: "skipped",
            reason: "Describe the image and its chart x axis.",
          });
          return;
        }
        searching = true;
        actor.send({ type: "SEARCH" });
        object = await Promise.race([
          createAnchoredImage(
            p.query,
            p.targetId,
            scene,
            controller.signal,
            this.imageSearch,
          ),
          aborted,
        ]);
        if (generation !== this.generation || controller.signal.aborted) {
          if (actor.getSnapshot().status === "active")
            actor.send({ type: "INVALIDATE" });
          return;
        }
        if (!object) {
          actor.send({ type: "SKIP" });
          this.send({
            type: "skipped",
            reason:
              "No usable web image was found. Try a more specific description.",
          });
          return;
        }
      }
      if (fromSpeech) {
        seen.add(fingerprint);
        if (seen.size > 100) seen.delete(seen.values().next().value!);
      }
      const action: VisualAction = {
        id,
        type: p.type,
        animation: p.animation,
        color: p.color,
        durationMs: p.durationMs,
        sequence: p.sequence,
        targetId: p.targetId,
        label: p.label,
        object: object ?? undefined,
        navigation: p.navigation,
        dx: p.dx,
        dy: p.dy,
        patch: p.patch,
        objects: illustration?.objects.slice(scene.objects.length),
        connections: illustration?.connections.slice(scene.connections.length),
        area: illustration?.areas?.find(
          (area) => area.id === illustration?.activeAreaId,
        ),
        viewport: illustration?.viewport,
        source: illustrationSource,
        served: illustrationServed ?? p.served,
        reason:
          illustrationSource === "demo"
            ? "Added a predefined illustration template (demo); no model generation was performed."
            : illustrationSource === "live"
              ? "Created an editable illustration with Nemotron on Nebius."
              : p.reason,
        sceneId: scene.id,
        revision,
      };
      actor.send({ type: "READY" });
      actor.send({ type: "DISPATCH" });
      this.actors.set(id, actor);
      if (fromSpeech && !final) this.speculative.add(id);
      this.pending = undefined;
      if (p.type === "sequence" && p.sequence?.domain === "architecture.aws-request-flow") {
        this.architectureResolvingAction = undefined;
        this.architecturePlaybackAction = id;
      }
      if (this.actors.size > 100) {
        const oldest = this.actors.keys().next().value!;
        this.actors.get(oldest)?.stop();
        this.actors.delete(oldest);
      }
      this.send({ type: "action", action });
    } catch (error) {
      if (generation !== this.generation) return;
      // Speculative speech may end mid-word. Reject that proposal quietly and
      // let the final transcript resolve normally; provider failures still surface.
      if (!final && fromSpeech && error instanceof ModelResponseError) {
        actor.send({ type: "SKIP" });
        return;
      }
      actor.send({ type: "FAIL" });
      this.send({
        type: "error",
        message:
          planning &&
          (controller.signal.aborted ||
            (error instanceof Error && error.name === "TimeoutError"))
            ? "Planning timed out. Try a simpler idea or a narrower topic."
            : searching &&
                (controller.signal.aborted ||
                  (error instanceof Error && error.name === "TimeoutError"))
              ? "Image search timed out. Try again."
              : controller.signal.aborted
                ? "Action interpretation timed out. Try a shorter cue."
                : error instanceof ZodError || error instanceof SyntaxError
                  ? "I could not read that visual action. Please name the object and try again."
                  : error instanceof Error
                    ? error.message.slice(0, 300)
                    : "Action interpretation failed.",
      });
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", onAbort);
      if (this.architectureResolvingAction === id) {
        this.architectureResolvingAction = undefined;
        this.drainArchitectureQueue();
      }
    }
  }
  applied(id: string) {
    this.actors.get(id)?.send({ type: "APPLIED" });
  }
  complete(id: string) {
    for (const [sequenceId, record] of this.sequenceSnapshots)
      if (record.actionId === id) this.sequenceSnapshots.delete(sequenceId);
    this.actors.get(id)?.send({ type: "COMPLETE" });
    this.actors.delete(id);
    if (this.architecturePlaybackAction === id) {
      this.architecturePlaybackAction = undefined;
      this.drainArchitectureQueue();
    }
  }
  cancel(id: string) {
    for (const [sequenceId, record] of this.sequenceSnapshots)
      if (record.actionId === id) this.sequenceSnapshots.delete(sequenceId);
    const actor = this.actors.get(id);
    if (actor?.getSnapshot().status === "active") actor.send({ type: "INVALIDATE" });
    this.actors.delete(id);
    if (this.architecturePlaybackAction === id) {
      this.architecturePlaybackAction = undefined;
      this.architectureQueue = [];
    }
    if (this.architectureResolvingAction === id) {
      this.architectureResolvingAction = undefined;
      this.abort?.abort();
      this.architectureQueue = [];
    }
  }
  private drainArchitectureQueue() {
    if (
      this.architecturePlaybackAction ||
      this.architectureResolvingAction ||
      this.architectureQueue.length === 0 ||
      !this.scene
    )
      return;
    const next = this.architectureQueue.shift()!;
    void this.cue(next.text, true, next.fromSpeech, next.seen);
  }
  close() {
    this.architectureQueue = [];
    this.architecturePlaybackAction = undefined;
    this.architectureResolvingAction = undefined;
    this.invalidate();
    this.session.send({ type: "CLOSE" });
    this.session.stop();
  }
}
