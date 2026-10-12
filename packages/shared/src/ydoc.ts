import * as Y from "yjs";
import {
  BoardAreaSchema,
  CueSchema,
  INK_MAX_STROKES,
  InkStrokeSchema,
  LessonContextSchema,
  ProjectSchema,
  SceneConnectionSchema,
  SceneObjectSchema,
  SceneSchema,
  hasTarget,
  resolveImageAnchor,
  type BoardArea,
  type InkStroke,
  type Project,
  type Scene,
  type SceneConnection,
  type SceneObject,
} from "./index.js";
import { invalidateDerivedResults } from "./presentation.js";

/**
 * Shared Yjs document helpers. The Y.Doc is the authoritative collaborative
 * copy of a Project; plain `Project` values are derived snapshots. Per-user
 * view state (`viewport`, `activeAreaId`) is never stored in the document.
 *
 * Note: no schema value from ./index.js may be used at module top level
 * (index.ts re-exports this module, so evaluation order is cyclic).
 */
export const PROJECT_ROOT = "project";
export const PROJECT_DOC_SCHEMA = 1;
export type CollabSource =
  | "user"
  | "ai"
  | "sequence"
  | "seed"
  | "repair"
  | "import"
  | "load";
/** Transaction origin for edits made by this replica. UndoManager tracks the class. */
export class LocalOrigin {
  constructor(
    readonly clientId: string,
    readonly source: CollabSource,
    readonly sequenceId?: string,
  ) {}
}

type Cue = Project["cues"][number];
type AnyMap = Y.Map<unknown>;
type AnyArray = Y.Array<unknown>;
type Plain = Record<string, unknown>;

const VIEW_KEYS = new Set(["viewport", "activeAreaId"]);
const SCENE_ARRAYS = new Set(["areas", "objects", "connections", "ink"]);

/* ------------------------------------------------------------------ */
/* JSON helpers                                                        */
/* ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Plain {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Recursively copy a JSON-like value, dropping `undefined` object keys and array entries. */
export function cleanValue<T>(value: T): T {
  if (Array.isArray(value))
    return value
      .filter((item) => item !== undefined)
      .map((item) => cleanValue(item)) as T;
  if (isPlainObject(value)) {
    const out: Plain = {};
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) out[key] = cleanValue(item);
    return out as T;
  }
  return value;
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value))
    return value.filter((item) => item !== undefined).map(sortedValue);
  if (isPlainObject(value)) {
    const out: Plain = {};
    for (const key of Object.keys(value).sort())
      if (value[key] !== undefined) out[key] = sortedValue(value[key]);
    return out;
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(sortedValue(value)) ?? "";
}
/** Order-independent JSON: recursively sorted keys, `undefined` dropped. */
export function canonicalScene(scene: Scene): string {
  return canonical(scene);
}
export function canonicalProject(project: Project): string {
  return canonical(project);
}

/* ------------------------------------------------------------------ */
/* Key order (schema declaration order, resolved lazily)               */
/* ------------------------------------------------------------------ */

let keyOrder:
  | {
      project: string[];
      scene: string[];
      object: string[];
      connection: string[];
      area: string[];
    }
  | undefined;
function keys() {
  return (keyOrder ??= {
    project: Object.keys(ProjectSchema.innerType().shape),
    scene: Object.keys(SceneSchema.innerType().shape),
    object: Object.keys(SceneObjectSchema.innerType().shape),
    connection: Object.keys(SceneConnectionSchema.shape),
    area: Object.keys(BoardAreaSchema.shape),
  });
}

/* ------------------------------------------------------------------ */
/* Plain -> Y                                                          */
/* ------------------------------------------------------------------ */

function leafMap(value: Plain): AnyMap {
  const map = new Y.Map<unknown>();
  for (const [key, item] of Object.entries(value))
    if (item !== undefined && item !== null) map.set(key, cleanValue(item));
  return map;
}

function sceneMap(scene: Scene): AnyMap {
  const map = new Y.Map<unknown>();
  for (const [key, item] of Object.entries(scene)) {
    if (item === undefined || VIEW_KEYS.has(key) || SCENE_ARRAYS.has(key))
      continue;
    map.set(key, cleanValue(item));
  }
  // Arrays are always created with the scene so concurrent first writes never race to create them.
  map.set("areas", Y.Array.from((scene.areas ?? []).map(leafMap)));
  map.set("objects", Y.Array.from(scene.objects.map((o) => leafMap(o))));
  map.set("connections", Y.Array.from(scene.connections.map((c) => leafMap(c))));
  map.set("ink", Y.Array.from((scene.ink ?? []).map((s) => cleanValue(s))));
  return map;
}

function ensureArray(map: AnyMap, key: string): AnyArray {
  const existing = map.get(key);
  if (existing instanceof Y.Array) return existing as AnyArray;
  const created = new Y.Array<unknown>();
  map.set(key, created);
  return created;
}

function ensureMap(map: AnyMap, key: string): AnyMap {
  const existing = map.get(key);
  if (existing instanceof Y.Map) return existing as AnyMap;
  const created = new Y.Map<unknown>();
  map.set(key, created);
  return created;
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Seed an empty document from a plain project in one transaction. */
export function fromPlain(
  doc: Y.Doc,
  project: Project,
  origin: LocalOrigin | string,
): void {
  const root = doc.getMap<unknown>(PROJECT_ROOT);
  const existing = root.get("scenes");
  if (existing instanceof Y.Array && existing.length > 0)
    throw new Error("The collaborative document is already seeded.");
  doc.transact(() => {
    if (typeof root.get("id") !== "string") root.set("id", project.id);
    root.set("title", project.title);
    root.set("updatedAt", project.updatedAt ?? new Date().toISOString());
    const meta = ensureMap(root, "meta");
    if (meta.get("schema") !== PROJECT_DOC_SCHEMA)
      meta.set("schema", PROJECT_DOC_SCHEMA);
    if (typeof meta.get("docId") !== "string") meta.set("docId", randomId());
    const scenes = ensureArray(root, "scenes");
    scenes.push(project.scenes.map(sceneMap));
    const cues = ensureArray(root, "cues");
    if (cues.length) cues.delete(0, cues.length);
    cues.push(project.cues.map((cue) => cleanValue(cue)));
  }, origin);
}

/* ------------------------------------------------------------------ */
/* Y -> Plain                                                          */
/* ------------------------------------------------------------------ */

function readLeaves(map: AnyMap, order: readonly string[]): Plain {
  const out: Plain = {};
  const known = new Set(order);
  for (const key of order) {
    if (VIEW_KEYS.has(key)) continue;
    const value = map.get(key);
    if (value !== undefined && value !== null) out[key] = cleanValue(value);
  }
  for (const key of [...map.keys()].sort()) {
    if (known.has(key) || VIEW_KEYS.has(key)) continue;
    const value = map.get(key);
    if (value !== undefined && value !== null && !(value instanceof Y.AbstractType))
      out[key] = cleanValue(value);
  }
  return out;
}

function mapsOf(value: unknown, order: readonly string[]): Plain[] {
  if (!(value instanceof Y.Array)) return [];
  return value
    .toArray()
    .filter((item): item is AnyMap => item instanceof Y.Map)
    .map((item) => readLeaves(item, order));
}

function readScene(map: AnyMap): Scene {
  const k = keys();
  const out: Plain = {};
  for (const key of k.scene) {
    if (VIEW_KEYS.has(key)) continue;
    const value = map.get(key);
    if (key === "objects") out.objects = mapsOf(value, k.object);
    else if (key === "connections")
      out.connections = mapsOf(value, k.connection);
    else if (key === "areas") {
      const areas = mapsOf(value, k.area);
      if (areas.length) out.areas = areas;
    } else if (key === "ink") {
      const ink =
        value instanceof Y.Array
          ? value
              .toArray()
              .filter((s) => s !== undefined && s !== null)
              .map((s) => cleanValue(s))
          : [];
      if (ink.length) out.ink = ink;
    } else if (value !== undefined && value !== null)
      out[key] = cleanValue(value);
  }
  const known = new Set(k.scene);
  for (const key of [...map.keys()].sort()) {
    if (known.has(key)) continue;
    const value = map.get(key);
    if (value !== undefined && value !== null && !(value instanceof Y.AbstractType))
      out[key] = cleanValue(value);
  }
  return out as unknown as Scene;
}

export interface PlainCache {
  get(map: AnyMap): Scene | undefined;
  set(map: AnyMap, scene: Scene): void;
  invalidate(map: AnyMap): void;
  /** Subscribe once per document so committed changes invalidate the touched scenes before any observer runs. */
  track(doc: Y.Doc): void;
}

/** The scene Y.Map that contains `type`, if any. */
function sceneMapOf(type: Y.AbstractType<any>, doc: Y.Doc): AnyMap | undefined {
  const scenes = doc.getMap<unknown>(PROJECT_ROOT).get("scenes");
  if (!(scenes instanceof Y.Array)) return undefined;
  let current: Y.AbstractType<any> | null = type;
  while (current) {
    const parent: Y.AbstractType<any> | null = current.parent;
    if (parent === scenes)
      return current instanceof Y.Map ? (current as AnyMap) : undefined;
    current = parent;
  }
  return undefined;
}

/** Structural sharing for `toPlain`: unchanged scenes keep their previous object identity. */
export function createPlainCache(): PlainCache {
  const scenes = new WeakMap<AnyMap, Scene>();
  const docs = new WeakSet<Y.Doc>();
  return {
    get: (map) => scenes.get(map),
    set: (map, scene) => void scenes.set(map, scene),
    invalidate: (map) => void scenes.delete(map),
    track(doc) {
      if (docs.has(doc)) return;
      docs.add(doc);
      // beforeObserverCalls runs after the transaction commits but before any observeDeep callback,
      // so a callback that calls toPlain never sees a stale cached scene.
      doc.on("beforeObserverCalls", (transaction) => {
        for (const type of transaction.changed.keys()) {
          const map = sceneMapOf(type, doc);
          if (map) scenes.delete(map);
        }
      });
    },
  };
}

/** Derive a plain project snapshot. Not validated; run `repairProject` before trusting it. */
export function toPlain(doc: Y.Doc, cache?: PlainCache): Project {
  const root = doc.getMap<unknown>(PROJECT_ROOT);
  // Inside an open transaction the cache cannot have been invalidated yet.
  const useCache = cache && doc._transaction === null;
  if (useCache) cache.track(doc);
  const scenesValue = root.get("scenes");
  const scenes =
    scenesValue instanceof Y.Array
      ? scenesValue
          .toArray()
          .filter((item): item is AnyMap => item instanceof Y.Map)
          .map((map) => {
            if (useCache) {
              const hit = cache.get(map);
              if (hit) return hit;
            }
            const scene = readScene(map);
            if (useCache) cache.set(map, scene);
            return scene;
          })
      : [];
  const cuesValue = root.get("cues");
  const cues =
    cuesValue instanceof Y.Array
      ? cuesValue
          .toArray()
          .filter((cue) => cue !== undefined && cue !== null)
          .map((cue) => cleanValue(cue) as Cue)
      : [];
  const updatedAt = root.get("updatedAt");
  const values: Plain = {
    id: root.get("id"),
    title: root.get("title") ?? "",
    scenes,
    cues,
    updatedAt:
      typeof updatedAt === "string" ? updatedAt : new Date(0).toISOString(),
  };
  const out: Plain = {};
  for (const key of keys().project)
    if (values[key] !== undefined) out[key] = values[key];
  return out as unknown as Project;
}

/* ------------------------------------------------------------------ */
/* Three-way diff                                                      */
/* ------------------------------------------------------------------ */

export type DiffSkip = { path: string; reason: "missing-in-doc" };
export type DiffResult = { changed: boolean; skipped: DiffSkip[] };

function diffView(project: Project): unknown {
  return {
    title: project.title,
    cues: project.cues,
    scenes: project.scenes.map((scene) => {
      const { viewport: _v, activeAreaId: _a, ...rest } = scene;
      return {
        ...rest,
        ink: rest.ink?.length ? rest.ink : undefined,
        areas: rest.areas?.length ? rest.areas : undefined,
      };
    }),
  };
}

function idOf(value: unknown): string | undefined {
  if (value instanceof Y.Map) {
    const id = value.get("id");
    return typeof id === "string" ? id : undefined;
  }
  if (isPlainObject(value) && typeof value.id === "string") return value.id;
  return undefined;
}

/**
 * Apply the edits that turned `base` into `next` onto the document, keyed by ID.
 * Only fields that differ between base and next are written, so concurrent peer
 * edits to other fields survive. Ignores project `id`, `updatedAt` and view state.
 */
export function applyDiff(
  doc: Y.Doc,
  base: Project,
  next: Project,
  origin: LocalOrigin | string,
): DiffResult {
  const result: DiffResult = { changed: false, skipped: [] };
  if (canonical(diffView(base)) === canonical(diffView(next))) return result;
  let changed = false;
  const skip = (path: string) =>
    result.skipped.push({ path, reason: "missing-in-doc" });

  const setLeaf = (map: AnyMap, key: string, value: unknown) => {
    if (value === undefined) {
      if (map.has(key)) {
        map.delete(key);
        changed = true;
      }
      return;
    }
    const clean = cleanValue(value);
    if (canonical(map.get(key)) === canonical(clean)) return;
    map.set(key, clean);
    changed = true;
  };

  const diffLeaves = (
    map: AnyMap,
    before: Plain,
    after: Plain,
    ignore: Set<string>,
  ) => {
    const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of fields) {
      if (key === "id" || ignore.has(key)) continue;
      if (canonical(before[key]) === canonical(after[key])) continue;
      setLeaf(map, key, after[key]);
    }
  };

  /** ID-keyed list of Y.Maps whose fields are all leaves. */
  const diffKeyed = (
    array: AnyArray,
    before: readonly Plain[],
    after: readonly Plain[],
    order: readonly string[],
    path: string,
  ) => {
    const ids = array.toArray().map(idOf);
    const afterIds = new Set(after.map((item) => item.id as string));
    const beforeById = new Map(before.map((item) => [item.id as string, item]));
    for (const item of before) {
      if (afterIds.has(item.id as string)) continue;
      const index = ids.indexOf(item.id as string);
      if (index < 0) continue;
      array.delete(index, 1);
      ids.splice(index, 1);
      changed = true;
    }
    after.forEach((item, position) => {
      const id = item.id as string;
      const prior = beforeById.get(id);
      const index = ids.indexOf(id);
      if (index < 0) {
        if (prior) {
          if (canonical(prior) !== canonical(item)) skip(`${path}/${id}`);
          return;
        }
        const at = Math.min(position, array.length);
        array.insert(at, [leafMap(item)]);
        ids.splice(at, 0, id);
        changed = true;
        return;
      }
      const map = array.get(index) as AnyMap;
      diffLeaves(map, prior ?? readLeaves(map, order), item, new Set());
    });
  };

  /** ID-set diff over plain values; changed content is delete + insert. */
  const diffPlainList = (
    array: AnyArray,
    before: readonly Plain[],
    after: readonly Plain[],
    clearAll: boolean,
  ) => {
    if (clearAll) {
      if (array.length) {
        array.delete(0, array.length);
        changed = true;
      }
      return;
    }
    const ids = array.toArray().map(idOf);
    const beforeById = new Map(before.map((item) => [item.id as string, item]));
    const afterById = new Map(after.map((item) => [item.id as string, item]));
    const remove = new Set<string>();
    for (const item of before) {
      const replacement = afterById.get(item.id as string);
      if (!replacement || canonical(replacement) !== canonical(item))
        remove.add(item.id as string);
    }
    const added = after.filter((item) => {
      const prior = beforeById.get(item.id as string);
      return !prior || canonical(prior) !== canonical(item);
    });
    // A peer may already hold an entry with an ID this replica is adding: replace it.
    for (const item of added) remove.add(item.id as string);
    for (let index = ids.length - 1; index >= 0; index--) {
      if (ids[index] === undefined || !remove.has(ids[index]!)) continue;
      array.delete(index, 1);
      ids.splice(index, 1);
      changed = true;
    }
    for (const item of added) {
      const at = Math.min(after.indexOf(item), array.length);
      array.insert(at, [cleanValue(item)]);
      ids.splice(at, 0, item.id as string);
      changed = true;
    }
  };

  const diffScene = (map: AnyMap, before: Scene, after: Scene) => {
    const k = keys();
    const path = `scenes/${after.id}`;
    diffLeaves(
      map,
      before as unknown as Plain,
      after as unknown as Plain,
      new Set([...VIEW_KEYS, ...SCENE_ARRAYS]),
    );
    if (canonical(before.areas ?? []) !== canonical(after.areas ?? []))
      diffKeyed(
        ensureArray(map, "areas"),
        (before.areas ?? []) as BoardArea[] as unknown as Plain[],
        (after.areas ?? []) as unknown as Plain[],
        k.area,
        `${path}/areas`,
      );
    if (canonical(before.objects) !== canonical(after.objects))
      diffKeyed(
        ensureArray(map, "objects"),
        before.objects as unknown as Plain[],
        after.objects as SceneObject[] as unknown as Plain[],
        k.object,
        `${path}/objects`,
      );
    if (canonical(before.connections) !== canonical(after.connections))
      diffKeyed(
        ensureArray(map, "connections"),
        before.connections as unknown as Plain[],
        after.connections as SceneConnection[] as unknown as Plain[],
        k.connection,
        `${path}/connections`,
      );
    const beforeInk = before.ink ?? [],
      afterInk = after.ink ?? [];
    if (canonical(beforeInk) !== canonical(afterInk))
      diffPlainList(
        ensureArray(map, "ink"),
        beforeInk as InkStroke[] as unknown as Plain[],
        afterInk as unknown as Plain[],
        afterInk.length === 0 && beforeInk.length > 0,
      );
  };

  doc.transact(() => {
    const root = doc.getMap<unknown>(PROJECT_ROOT);
    if (base.title !== next.title) setLeaf(root, "title", next.title);
    const scenes = ensureArray(root, "scenes");
    const ids = scenes.toArray().map(idOf);
    const nextIds = new Set(next.scenes.map((scene) => scene.id));
    const baseById = new Map(base.scenes.map((scene) => [scene.id, scene]));
    for (const scene of base.scenes) {
      if (nextIds.has(scene.id)) continue;
      const index = ids.indexOf(scene.id);
      if (index < 0) continue;
      scenes.delete(index, 1);
      ids.splice(index, 1);
      changed = true;
    }
    next.scenes.forEach((scene, position) => {
      const prior = baseById.get(scene.id);
      const index = ids.indexOf(scene.id);
      if (index < 0) {
        if (prior) {
          if (canonical(diffView({ ...base, scenes: [prior], cues: [] })) !==
              canonical(diffView({ ...base, scenes: [scene], cues: [] })))
            skip(`scenes/${scene.id}`);
          return;
        }
        const at = Math.min(position, scenes.length);
        scenes.insert(at, [sceneMap(scene)]);
        ids.splice(at, 0, scene.id);
        changed = true;
        return;
      }
      const map = scenes.get(index) as AnyMap;
      diffScene(map, prior ?? readScene(map), scene);
    });
    if (canonical(base.cues) !== canonical(next.cues))
      diffPlainList(
        ensureArray(root, "cues"),
        base.cues as unknown as Plain[],
        next.cues as unknown as Plain[],
        false,
      );
    if (changed) root.set("updatedAt", new Date().toISOString());
  }, origin);
  result.changed = changed;
  return result;
}

/* ------------------------------------------------------------------ */
/* Repair (read side)                                                  */
/* ------------------------------------------------------------------ */

export class RepairError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepairError";
  }
}

export const MAX_SCENES = 100;
export const MAX_OBJECTS = 300;
export const MAX_CONNECTIONS = 500;
export const MAX_AREAS = 200;
export const MAX_CUES = 1000;

function padCells(object: Plain): Plain {
  const cells = object.cells;
  if (!Array.isArray(cells) || !cells.every(Array.isArray)) return object;
  const rows = cells as unknown[][];
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (rows.every((row) => row.length === width)) return object;
  return {
    ...object,
    cells: rows.map((row) => [
      ...row,
      ...Array.from({ length: width - row.length }, () => 0),
    ]),
  };
}

function repairScene(raw: Plain, issues: string[]): Scene {
  const { viewport: _v, activeAreaId: _a, ...rest } = raw;
  const sceneId = String(rest.id);
  const label = (what: string) => `scene ${sceneId}: ${what}`;

  const objects: SceneObject[] = [];
  const objectIds = new Set<string>();
  for (const candidate of Array.isArray(rest.objects) ? rest.objects : []) {
    if (!isPlainObject(candidate)) {
      issues.push(label("dropped a malformed object"));
      continue;
    }
    const id = String(candidate.id);
    if (objectIds.has(id)) {
      issues.push(label(`dropped duplicate object ${id}`));
      continue;
    }
    const padded = padCells(candidate);
    if (padded !== candidate) issues.push(label(`padded ragged cells on ${id}`));
    const parsed = SceneObjectSchema.safeParse(padded);
    if (!parsed.success) {
      issues.push(label(`dropped invalid object ${id}`));
      continue;
    }
    if (objects.length >= MAX_OBJECTS) {
      issues.push(label(`dropped object ${id} over the ${MAX_OBJECTS} limit`));
      continue;
    }
    objectIds.add(id);
    objects.push(cleanValue(parsed.data));
  }

  const draft = { ...rest, objects, connections: [] } as unknown as Scene;
  const anchored = objects.map((object) => {
    if (!object.anchor) return object;
    const target = objects.find((t) => t.id === object.anchor!.targetId);
    if (
      object.kind === "image" &&
      target &&
      target.kind === "chart" &&
      target.id !== object.id
    )
      return object;
    issues.push(label(`dropped dangling anchor on ${object.id}`));
    const { anchor: _anchor, ...resolved } = resolveImageAnchor(object, draft);
    return resolved as SceneObject;
  });

  const connections: SceneConnection[] = [];
  const connectionIds = new Set<string>();
  for (const candidate of Array.isArray(rest.connections) ? rest.connections : []) {
    const parsed = SceneConnectionSchema.safeParse(candidate);
    const id = isPlainObject(candidate) ? String(candidate.id) : "?";
    if (!parsed.success) issues.push(label(`dropped invalid connection ${id}`));
    else if (connectionIds.has(id))
      issues.push(label(`dropped duplicate connection ${id}`));
    else if (!objectIds.has(parsed.data.source) || !objectIds.has(parsed.data.target))
      issues.push(label(`dropped connection ${id} with a missing endpoint`));
    else if (connections.length >= MAX_CONNECTIONS)
      issues.push(label(`dropped connection ${id} over the ${MAX_CONNECTIONS} limit`));
    else {
      connectionIds.add(id);
      connections.push(cleanValue(parsed.data));
    }
  }

  let areas: BoardArea[] | undefined;
  if (rest.areas !== undefined) {
    areas = [];
    const areaIds = new Set<string>();
    for (const candidate of Array.isArray(rest.areas) ? rest.areas : []) {
      const parsed = BoardAreaSchema.safeParse(candidate);
      const id = isPlainObject(candidate) ? String(candidate.id) : "?";
      if (!parsed.success) issues.push(label(`dropped invalid area ${id}`));
      else if (areaIds.has(id)) issues.push(label(`dropped duplicate area ${id}`));
      else if (areas.length >= MAX_AREAS)
        issues.push(label(`dropped area ${id} over the ${MAX_AREAS} limit`));
      else {
        areaIds.add(id);
        areas.push(cleanValue(parsed.data));
      }
    }
    if (!areas.length) areas = undefined;
  }

  let ink: InkStroke[] | undefined;
  if (rest.ink !== undefined) {
    const strokes: InkStroke[] = [];
    const strokeIds = new Set<string>();
    for (const candidate of Array.isArray(rest.ink) ? rest.ink : []) {
      const parsed = InkStrokeSchema.safeParse(candidate);
      const id = isPlainObject(candidate) ? String(candidate.id) : "?";
      if (!parsed.success) issues.push(label(`dropped invalid ink stroke ${id}`));
      else if (strokeIds.has(id))
        issues.push(label(`dropped duplicate ink stroke ${id}`));
      else {
        strokeIds.add(id);
        strokes.push(cleanValue(parsed.data));
      }
    }
    if (strokes.length > INK_MAX_STROKES)
      issues.push(
        label(`dropped ${strokes.length - INK_MAX_STROKES} oldest ink strokes`),
      );
    ink = strokes.slice(Math.max(0, strokes.length - INK_MAX_STROKES));
    if (!ink.length) ink = undefined;
  }

  let lesson = rest.lesson;
  if (lesson !== undefined && !LessonContextSchema.safeParse(lesson).success) {
    issues.push(label("dropped invalid lesson context"));
    lesson = undefined;
  }

  const scene = cleanValue({
    ...rest,
    areas,
    lesson,
    ink,
    objects: anchored,
    connections,
  }) as unknown as Scene;
  const invalidated = cleanValue(invalidateDerivedResults(scene));
  if (canonical(invalidated) !== canonical(scene))
    issues.push(label("hid derived results whose sources changed"));
  return invalidated;
}

const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Deterministic, idempotent read-side repair of a document-derived project.
 * Throws RepairError when the result still fails ProjectSchema.
 */
export function repairProject(
  plain: Project,
  routeId?: string,
): { project: Project; issues: string[] } {
  const issues: string[] = [];
  const input = (isPlainObject(plain) ? plain : {}) as Plain;
  const id = routeId ?? input.id;

  const scenes: Scene[] = [];
  const sceneIds = new Set<string>();
  for (const candidate of Array.isArray(input.scenes) ? input.scenes : []) {
    if (!isPlainObject(candidate)) {
      issues.push("dropped a malformed scene");
      continue;
    }
    const sceneId = String(candidate.id);
    if (sceneIds.has(sceneId)) {
      issues.push(`dropped duplicate scene ${sceneId}`);
      continue;
    }
    if (scenes.length >= MAX_SCENES) {
      issues.push(`dropped scene ${sceneId} over the ${MAX_SCENES} limit`);
      continue;
    }
    sceneIds.add(sceneId);
    scenes.push(repairScene(candidate, issues));
  }
  if (!scenes.length) {
    issues.push("added an empty scene to a project without scenes");
    scenes.push({
      id: "scene-1",
      title: "Untitled scene",
      subtitle: "",
      kind: "slide",
      objects: [],
      connections: [],
    });
  }

  const cues: Cue[] = [];
  const cueIds = new Set<string>();
  for (const candidate of Array.isArray(input.cues) ? input.cues : []) {
    const parsed = CueSchema.safeParse(candidate);
    const cueId = isPlainObject(candidate) ? String(candidate.id) : "?";
    if (!parsed.success) {
      issues.push(`dropped invalid cue ${cueId}`);
      continue;
    }
    const scene = scenes.find((s) => s.id === parsed.data.sceneId);
    if (cueIds.has(cueId)) issues.push(`dropped duplicate cue ${cueId}`);
    else if (!scene || !hasTarget(scene, parsed.data.targetId))
      issues.push(`dropped cue ${cueId} with a missing target`);
    else if (cues.length >= MAX_CUES)
      issues.push(`dropped cue ${cueId} over the ${MAX_CUES} limit`);
    else {
      cueIds.add(cueId);
      cues.push(cleanValue(parsed.data));
    }
  }

  let updatedAt = input.updatedAt;
  if (
    typeof updatedAt !== "string" ||
    !DATETIME.test(updatedAt) ||
    Number.isNaN(Date.parse(updatedAt))
  ) {
    issues.push("replaced an invalid updatedAt");
    updatedAt = new Date().toISOString();
  }

  const parsed = ProjectSchema.safeParse({
    id,
    title: input.title,
    scenes,
    cues,
    updatedAt,
  });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new RepairError(
      first
        ? `${first.path.join(".") || "project"}: ${first.message}`
        : "The project is invalid.",
    );
  }
  return { project: cleanValue(parsed.data), issues };
}

/* ------------------------------------------------------------------ */
/* Observation                                                         */
/* ------------------------------------------------------------------ */

export type SceneSection =
  | "meta"
  | "objects"
  | "connections"
  | "ink"
  | "areas"
  | "lesson";
export type ProjectChange = {
  origin: unknown;
  /** True when the transaction origin is a LocalOrigin. */
  local: boolean;
  /** Y client IDs whose state advanced in this transaction (inserts; deletions carry no author). */
  clientIds: Set<number>;
  scenes: Map<string, Set<SceneSection>>;
  /** Title, cue list, scene list or document metadata changed. `updatedAt` alone does not count. */
  project: boolean;
};
const ALL_SECTIONS: SceneSection[] = [
  "meta",
  "objects",
  "connections",
  "ink",
  "areas",
  "lesson",
];
function sectionFor(key: string | number | undefined): SceneSection {
  return key === "objects" ||
    key === "connections" ||
    key === "ink" ||
    key === "areas" ||
    key === "lesson"
    ? key
    : "meta";
}

/** One synchronous callback per transaction that touched the project root. */
export function observeProject(
  doc: Y.Doc,
  callback: (change: ProjectChange) => void,
): () => void {
  const root = doc.getMap<unknown>(PROJECT_ROOT);
  const handler = (events: Y.YEvent<any>[], transaction: Y.Transaction) => {
    const change: ProjectChange = {
      origin: transaction.origin,
      local: transaction.origin instanceof LocalOrigin,
      clientIds: new Set(),
      scenes: new Map(),
      project: false,
    };
    transaction.afterState.forEach((clock, client) => {
      if ((transaction.beforeState.get(client) ?? 0) !== clock)
        change.clientIds.add(client);
    });
    if (!change.clientIds.size && transaction.local)
      change.clientIds.add(doc.clientID);
    const add = (sceneId: unknown, sections: SceneSection[]) => {
      if (typeof sceneId !== "string") return;
      const set = change.scenes.get(sceneId) ?? new Set<SceneSection>();
      for (const section of sections) set.add(section);
      change.scenes.set(sceneId, set);
    };
    const scenes = root.get("scenes");
    for (const event of events) {
      const path = event.path;
      const keysChanged: Set<string> =
        event instanceof Y.YMapEvent ? event.keysChanged : new Set();
      if (path.length === 0) {
        for (const key of keysChanged)
          if (key !== "updatedAt") change.project = true;
        continue;
      }
      if (path[0] !== "scenes") {
        change.project = true;
        continue;
      }
      if (path.length === 1) {
        change.project = true;
        for (const item of event.changes.added)
          for (const content of item.content.getContent())
            if (content instanceof Y.Map) add(content.get("id"), ALL_SECTIONS);
        continue;
      }
      const sceneMapValue =
        scenes instanceof Y.Array && typeof path[1] === "number"
          ? scenes.get(path[1])
          : undefined;
      if (!(sceneMapValue instanceof Y.Map)) continue;
      const sceneId = sceneMapValue.get("id");
      if (path.length === 2)
        add(
          sceneId,
          [...keysChanged].map((key) => sectionFor(key)),
        );
      else add(sceneId, [sectionFor(path[2])]);
    }
    callback(change);
  };
  root.observeDeep(handler);
  return () => root.unobserveDeep(handler);
}
