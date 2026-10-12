import { ZodError } from "zod";
import {
  appendIllustration,
  getSceneViewport,
  applyObjectEdit,
  hasTarget,
  validatePresentationSequence,
  type BoardViewport,
} from "@vizli/shared";
import { generateScene, type ScenePlanner } from "./generate.js";
import type { LessonAuthor } from "./lessons.js";
import { isArchitectureDomainCue } from "./domains/architecture.js";
import { createAnchoredImage, type ImageSearch } from "./images.js";
import { createActor, createMachine, type AnyActorRef } from "xstate";
import { randomUUID } from "node:crypto";
import type {
  Scene,
  Project,
  PresentationSequence,
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
/**
 * The scene a session interprets against. The session never owns the project: it reads the
 * current value on demand and is told about changes through `sync`. `version` is stamped into
 * dispatched actions as `revision`.
 */
export type ViewCamera = { viewport?: BoardViewport; activeAreaId?: string };
export type ProjectSource = {
  readonly project: Project;
  readonly version: number;
};
const SCENE_CHANGED_REASON =
  "The scene changed while I was interpreting that; say it again.";
/** Per-viewer or annotation-only scene fields; changes to them never invalidate sequence ownership. */
const NON_CONTENT_SCENE_FIELDS = new Set([
  "objects",
  "connections",
  "lesson",
  "ink",
  "areas",
  "viewport",
  "activeAreaId",
]);
/** IDs whose canonical JSON differs between two lists (added, removed or changed). */
function changedIds(
  before: ReadonlyArray<{ id: string }>,
  after: ReadonlyArray<{ id: string }>,
): Set<string> {
  const previous = new Map(before.map((item) => [item.id, stableJson(item)]));
  const changed = new Set<string>();
  for (const item of after) {
    const json = previous.get(item.id);
    if (json !== stableJson(item)) changed.add(item.id);
    previous.delete(item.id);
  }
  for (const id of previous.keys()) changed.add(id);
  return changed;
}
/** Objects and connections a sequence inserts, replaces or reveals. Context steps only touch `lesson`. */
function sequenceOwnedIds(sequence: PresentationSequence): Set<string> {
  const owned = new Set<string>();
  for (const step of sequence.steps) {
    if (step.type === "insert") {
      for (const object of step.objects) owned.add(object.id);
      for (const connection of step.connections ?? []) owned.add(connection.id);
    } else if (step.type === "update")
      for (const object of step.objects) owned.add(object.id);
    else if (step.type === "reveal") {
      owned.add(step.targetId);
      owned.add(step.targetId.split(":")[0]!);
    }
  }
  return owned;
}
/** Pre-existing objects a dispatched sequence reads or modifies; a peer deleting one invalidates it. */
function sequenceDependencies(
  scene: Scene,
  sequence: PresentationSequence,
): string[] {
  const existing = new Set(scene.objects.map((object) => object.id));
  const refs = new Set(sequence.sourceIds ?? []);
  for (const step of sequence.steps) {
    if (step.type === "insert")
      for (const connection of step.connections ?? []) {
        refs.add(connection.source);
        refs.add(connection.target);
      }
    else if (step.type === "update")
      for (const object of step.objects) refs.add(object.id);
    else if (step.type === "reveal") refs.add(step.targetId);
    else if (step.type === "context")
      for (const id of step.lesson.sourceIds) refs.add(id);
  }
  return [...refs].filter((id) => existing.has(id));
}
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
  private source?: ProjectSource;
  private viewedSceneId?: string;
  private viewedCamera?: ViewCamera;
  /** The viewed scene as of the last attach/view/sync; `sync` diffs against it. */
  private lastScene?: Scene;
  /** Live sequence playback: the objects/connections its self-commits may change without invalidating acknowledgements. */
  private sequenceOwnership = new Map<
    string,
    { actionId: string; sceneId: string; ownedIds: Set<string> }
  >();
  /** What each dispatched actor depends on, so a peer edit can prune exactly the actors it broke. */
  private dispatched = new Map<
    string,
    { targetId?: string; dependsOn?: string[] }
  >();
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
  private get scene(): Scene | undefined {
    const scenes = this.source?.project.scenes;
    if (!scenes?.length) return undefined;
    const scene = scenes.find((scene) => scene.id === this.viewedSceneId) ?? scenes[0];
    // The camera is per-user and lives outside the shared document; planners still need the viewer's camera.
    const view = this.viewedCamera;
    if (!view || scene.id !== this.viewedSceneId) return scene;
    return {
      ...scene,
      ...(view.viewport ? { viewport: view.viewport } : {}),
      ...(view.activeAreaId ? { activeAreaId: view.activeAreaId } : {}),
    };
  }
  private get cues(): Project["cues"] {
    return this.source?.project.cues ?? [];
  }
  private get revision(): number {
    return this.source?.version ?? 0;
  }
  /** Read scenes from `source`; view `sceneId` (default: the first scene). */
  attach(source: ProjectSource, sceneId?: string) {
    this.source = source;
    this.viewedSceneId = sceneId ?? source.project.scenes[0]?.id;
    this.lastScene = this.scene;
    this.resetArchitecture();
    this.invalidate();
    this.speechSeen.clear();
    this.session.send({ type: "SCENE" });
    this.send({ type: "state", state: "ready" });
  }
  /** Change the viewed scene. Unknown IDs fall back to the first scene. */
  view(sceneId: string, camera?: ViewCamera) {
    const previous = this.scene?.id;
    const scenes = this.source?.project.scenes ?? [];
    this.viewedSceneId = scenes.some((scene) => scene.id === sceneId)
      ? sceneId
      : (scenes[0]?.id ?? sceneId);
    this.viewedCamera = camera;
    this.lastScene = this.scene;
    if (this.scene?.id !== previous) this.resetScene();
  }
  /** No project (e.g. the room is gone): cues skip until the next attach. */
  clearScene() {
    this.source = undefined;
    this.viewedSceneId = undefined;
    this.viewedCamera = undefined;
    this.lastScene = undefined;
    this.resetScene();
  }
  /**
   * The source project changed. `self` commits come from this presenter (sequence playback, undo,
   * direct edits) and keep today's abort semantics; `peer` commits never abort interpretation and
   * only prune dispatched actors whose targets vanished.
   */
  sync(origin: "self" | "peer") {
    if (!this.source) return;
    const next = this.scene,
      prev = this.lastScene;
    this.lastScene = next;
    if (!next || !prev || prev.id !== next.id) {
      this.resetScene();
      return;
    }
    if (origin === "peer") {
      this.pruneActors(next);
      return;
    }
    const content =
      prev.layout !== next.layout ||
      stableJson(prev.objects) !== stableJson(next.objects) ||
      stableJson(prev.connections) !== stableJson(next.connections);
    const preserve = !content || this.sequenceOwned(prev, next);
    if (!preserve) this.resetArchitecture();
    this.invalidate(preserve);
    this.speechSeen.clear();
  }
  private resetScene() {
    this.resetArchitecture();
    this.invalidate();
    this.speechSeen.clear();
  }
  private resetArchitecture() {
    this.architectureQueue = [];
    this.architectureResolvingAction = undefined;
    this.architecturePlaybackAction = undefined;
  }
  /** True iff every changed object/connection belongs to a live sequence and no other scene-level field changed. */
  private sequenceOwned(prev: Scene, next: Scene): boolean {
    const owned = new Set<string>();
    for (const record of this.sequenceOwnership.values())
      if (record.sceneId === next.id)
        for (const id of record.ownedIds) owned.add(id);
    if (owned.size === 0) return false;
    const rest = (scene: Scene) =>
      stableJson(
        Object.fromEntries(
          Object.entries(scene).filter(
            ([key]) => !NON_CONTENT_SCENE_FIELDS.has(key),
          ),
        ),
      );
    if (rest(prev) !== rest(next)) return false;
    for (const id of changedIds(prev.objects, next.objects))
      if (!owned.has(id)) return false;
    for (const id of changedIds(prev.connections, next.connections))
      if (!owned.has(id)) return false;
    return true;
  }
  /** Peer edits: invalidate only dispatched actors whose target or sequence dependencies vanished. */
  private pruneActors(next: Scene) {
    const objectIds = new Set(next.objects.map((object) => object.id));
    for (const [id, actor] of this.actors) {
      const record = this.dispatched.get(id);
      if (!record) continue;
      const lost =
        (record.targetId !== undefined && !hasTarget(next, record.targetId)) ||
        record.dependsOn?.some((dependency) => !objectIds.has(dependency));
      if (!lost) continue;
      if (actor.getSnapshot().status === "active")
        actor.send({ type: "INVALIDATE" });
      this.forget(id);
      if (this.architecturePlaybackAction === id) {
        this.architecturePlaybackAction = undefined;
        this.architectureQueue = [];
      }
    }
  }
  /** Drop every record of a dispatched action. */
  private forget(id: string) {
    this.actors.delete(id);
    this.dispatched.delete(id);
    this.speculative.delete(id);
    for (const [sequenceId, record] of this.sequenceOwnership)
      if (record.actionId === id) this.sequenceOwnership.delete(sequenceId);
  }
  /** Re-check a proposal against the live scene after a concurrent change. Undefined means it no longer applies. */
  private revalidate(
    p: ResolvedActionProposal,
    live: Scene,
    generated?: Scene,
  ): { illustration?: Scene } | undefined {
    try {
      if (p.targetId && !hasTarget(live, p.targetId)) return undefined;
      switch (p.type) {
        case "edit_object":
          applyObjectEdit(live, p.targetId!, p.patch!);
          break;
        case "sequence":
          validatePresentationSequence(live, p.sequence!);
          break;
        case "navigate":
          if (
            p.navigation?.targetId &&
            !hasTarget(live, p.navigation.targetId)
          )
            return undefined;
          if (
            p.navigation?.areaId &&
            !live.areas?.some((area) => area.id === p.navigation!.areaId)
          )
            return undefined;
          break;
        case "add_image":
          if (
            !live.objects.some(
              (object) => object.id === p.targetId && object.kind === "chart",
            )
          )
            return undefined;
          break;
        case "add_illustration":
          if (!generated || live.layout !== "whiteboard") return undefined;
          return { illustration: appendIllustration(live, generated) };
      }
      return {};
    } catch {
      return undefined;
    }
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
      this.dispatched.clear();
      this.sequenceOwnership.clear();
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
      this.forget(id);
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
      }
      let object;
      let illustration: Scene | undefined;
      let generated: Scene | undefined;
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
        generated = result.scene;
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
      // Dispatch-time revalidation: a peer (or anything that did not abort this cue) may have
      // changed the scene while the model was thinking. Re-check against the live scene.
      let base = scene;
      const live = this.scene;
      if (live !== scene && (!live || stableJson(live) !== stableJson(scene))) {
        const revalidated =
          live && live.id === scene.id
            ? this.revalidate(p, live, generated)
            : undefined;
        if (!revalidated) {
          actor.send({ type: "SKIP" });
          this.send({ type: "skipped", reason: SCENE_CHANGED_REASON });
          return;
        }
        base = live!;
        if (revalidated.illustration) illustration = revalidated.illustration;
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
        objects: illustration?.objects.slice(base.objects.length),
        connections: illustration?.connections.slice(base.connections.length),
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
        sceneId: base.id,
        revision: this.revision,
      };
      actor.send({ type: "READY" });
      actor.send({ type: "DISPATCH" });
      this.actors.set(id, actor);
      this.dispatched.set(id, {
        targetId: p.targetId,
        dependsOn: p.sequence
          ? sequenceDependencies(base, p.sequence)
          : undefined,
      });
      if (p.type === "sequence" && p.sequence) {
        this.sequenceOwnership.set(p.sequence.id, {
          actionId: id,
          sceneId: base.id,
          ownedIds: sequenceOwnedIds(p.sequence),
        });
        if (this.sequenceOwnership.size > 100)
          this.sequenceOwnership.delete(
            this.sequenceOwnership.keys().next().value!,
          );
      }
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
        this.dispatched.delete(oldest);
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
    this.actors.get(id)?.send({ type: "COMPLETE" });
    this.forget(id);
    if (this.architecturePlaybackAction === id) {
      this.architecturePlaybackAction = undefined;
      this.drainArchitectureQueue();
    }
  }
  cancel(id: string) {
    const actor = this.actors.get(id);
    if (actor?.getSnapshot().status === "active") actor.send({ type: "INVALIDATE" });
    this.forget(id);
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
