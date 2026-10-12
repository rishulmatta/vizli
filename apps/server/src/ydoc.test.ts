import { describe, it, expect, vi } from "vitest";
import * as Y from "yjs";
import {
  addInkStroke,
  applyBoardNavigation,
  applyPresentationStep,
  canonicalProject,
  clearInk,
  createDemoProject,
  createPlainCache,
  fromPlain,
  applyDiff,
  INK_MAX_STROKES,
  LocalOrigin,
  observeProject,
  PROJECT_ROOT,
  ProjectSchema,
  removeInkStroke,
  repairProject,
  toPlain,
  cleanValue,
  type InkStroke,
  type Project,
  type ProjectChange,
  type Scene,
  type SceneObject,
} from "@vizli/shared";

const FIXED = "2026-10-12T10:00:00.000Z";
const stroke = (id: string, points: number[] = [10, 200, 40, 230]): InkStroke => ({
  id,
  color: "#d2432f",
  width: 6,
  points,
});
/** Demo project with a whiteboard scene (as in whiteboard.test.ts) and some ink. */
function fixture(): Project {
  const project = createDemoProject();
  project.updatedAt = FIXED;
  project.scenes[2] = {
    ...project.scenes[2]!,
    layout: "whiteboard",
    viewport: { x: 0, y: 0, zoom: 1 },
    areas: [{ id: "start", label: "Start", x: 0, y: 0, width: 1200, height: 675 }],
    activeAreaId: "start",
  };
  project.scenes[0] = addInkStroke(addInkStroke(project.scenes[0]!, stroke("ink-a")), {
    ...stroke("ink-b", [0, 0, 5, 5, 9, 9]),
    opacity: 0.45,
  });
  return project;
}
/** Remove what the document intentionally does not round-trip. */
function strip(project: Project): Project {
  const copy = structuredClone(project) as Omit<Project, "updatedAt"> & { updatedAt?: string };
  delete copy.updatedAt;
  copy.scenes = copy.scenes.map((scene) => {
    const { viewport: _v, activeAreaId: _a, ...rest } = scene;
    if (!rest.ink?.length) delete rest.ink;
    if (!rest.areas?.length) delete rest.areas;
    return rest;
  });
  return copy as Project;
}
const same = (a: Project, b: Project) => canonicalProject(strip(a)) === canonicalProject(strip(b));
const origin = (clientId = "client-a") => new LocalOrigin(clientId, "user");
function seeded(project = fixture()): Y.Doc {
  const doc = new Y.Doc();
  fromPlain(doc, project, "seed");
  return doc;
}
function sync(a: Y.Doc, b: Y.Doc) {
  const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, fromA);
  Y.applyUpdate(a, fromB);
}
function pair(): [Y.Doc, Y.Doc] {
  const a = seeded(), b = new Y.Doc();
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  return [a, b];
}
/** Edit the plain snapshot of `doc` and commit the difference. */
function commit(doc: Y.Doc, edit: (p: Project) => Project | void, clientId = "client-a") {
  const base = toPlain(doc);
  const draft = structuredClone(base);
  const next = edit(draft) ?? draft;
  return { base, next, result: applyDiff(doc, base, next, origin(clientId)) };
}
const scene = (p: Project, id: string) => p.scenes.find((s) => s.id === id)!;
const object = (p: Project, sceneId: string, id: string) =>
  scene(p, sceneId).objects.find((o) => o.id === id)!;
const replaceScene = (p: Project, next: Scene) => {
  p.scenes = p.scenes.map((s) => (s.id === next.id ? next : s));
};

describe("fromPlain / toPlain", () => {
  it("round-trips a project except updatedAt and per-user view state", () => {
    const project = fixture();
    const doc = seeded(project);
    const plain = toPlain(doc);
    expect(same(plain, project)).toBe(true);
    expect(plain.updatedAt).toBe(FIXED);
    expect(ProjectSchema.safeParse(plain).success).toBe(true);
    expect(plain.scenes[2]!.viewport).toBeUndefined();
    expect(plain.scenes[2]!.activeAreaId).toBeUndefined();
    const meta = doc.getMap(PROJECT_ROOT).get("meta") as Y.Map<unknown>;
    expect(meta.get("schema")).toBe(1);
    expect(typeof meta.get("docId")).toBe("string");
    // Remote replica decodes to the same snapshot.
    const remote = new Y.Doc();
    Y.applyUpdate(remote, Y.encodeStateAsUpdate(doc));
    expect(canonicalProject(toPlain(remote))).toBe(canonicalProject(plain));
  });

  it("refuses to seed twice and never stores undefined", () => {
    const doc = seeded();
    expect(() => fromPlain(doc, fixture(), "seed")).toThrow();
    const project = fixture();
    (project.scenes[0]!.objects[0] as SceneObject).color = undefined;
    const fresh = seeded(project);
    const objects = (
      (fresh.getMap(PROJECT_ROOT).get("scenes") as Y.Array<Y.Map<unknown>>).get(0).get("objects") as Y.Array<Y.Map<unknown>>
    ).get(0);
    expect(objects.has("color")).toBe(false);
    expect(cleanValue({ a: undefined, b: [1, undefined, { c: undefined }] })).toEqual({ b: [1, {}] });
  });

  it("shares unchanged scenes structurally through a plain cache", () => {
    const doc = seeded();
    const cache = createPlainCache();
    const first = toPlain(doc, cache);
    const again = toPlain(doc, cache);
    expect(again.scenes[0]).toBe(first.scenes[0]);
    let observed: Project | undefined;
    const stop = observeProject(doc, () => {
      observed = toPlain(doc, cache);
    });
    commit(doc, (p) => {
      object(p, "marketing", "revenue").x += 10;
    });
    stop();
    expect(observed!.scenes[0]).not.toBe(first.scenes[0]);
    expect(object(observed!, "marketing", "revenue").x).toBe(80);
    expect(observed!.scenes[1]).toBe(first.scenes[1]);
    expect(toPlain(doc, cache).scenes[0]).toBe(observed!.scenes[0]);
  });
});

const lesson = { domain: "architecture", sourceIds: ["api"], completedCueIds: [] };
const mutations: [string, (p: Project) => Project | void][] = [
  ["move object", (p) => { object(p, "marketing", "revenue").x = 140; object(p, "marketing", "revenue").y = 260; }],
  ["relabel", (p) => { object(p, "marketing", "conversion").label = "Conversion"; }],
  ["change cells", (p) => { object(p, "mathematics", "matrix-a").cells = [[1, 2, 3], [3, 4, 5]]; }],
  ["remove an optional field", (p) => { delete object(p, "marketing", "takeaway").hidden; }],
  ["add object", (p) => {
    scene(p, "architecture").objects.splice(1, 0, { id: "cache", kind: "node", label: "Cache", x: 430, y: 420, width: 230, height: 110 });
  }],
  ["delete object with its connections and cues", (p) => {
    const s = scene(p, "architecture");
    s.objects = s.objects.filter((o) => o.id !== "api");
    s.connections = [];
    const m = scene(p, "marketing");
    m.objects = m.objects.filter((o) => o.id !== "takeaway");
    p.cues = p.cues.filter((c) => c.targetId !== "takeaway");
  }],
  ["add ink", (p) => replaceScene(p, addInkStroke(scene(p, "marketing"), stroke("ink-c")))],
  ["erase ink", (p) => replaceScene(p, removeInkStroke(scene(p, "marketing"), "ink-a"))],
  ["clear ink", (p) => replaceScene(p, clearInk(scene(p, "marketing")))],
  ["add cue", (p) => { p.cues.push({ id: "cue-db", sceneId: "architecture", phrase: "the database", targetId: "database", action: "highlight" }); }],
  ["remove cue", (p) => { p.cues = p.cues.filter((c) => c.id !== "cue-revenue"); }],
  ["title change", (p) => { p.title = "A sharper story"; }],
  ["switch layout and add areas", (p) => {
    const s = scene(p, "mathematics");
    replaceScene(p, applyBoardNavigation({ ...s, layout: "whiteboard", areas: [{ id: "start", label: "Start", x: 0, y: 0, width: 1200, height: 675 }] }, { direction: "right" }));
  }],
  ["navigate a whiteboard", (p) => replaceScene(p, applyBoardNavigation(scene(p, "architecture"), { direction: "down" }))],
  ["sequence insert", (p) => replaceScene(p, applyPresentationStep(scene(p, "architecture"), {
    id: "s1", type: "insert", lesson,
    objects: [{ id: "queue", kind: "node", label: "Queue", x: 430, y: 480, width: 230, height: 100 }],
    connections: [{ id: "enqueue", source: "api", target: "queue", label: "Enqueue" }],
  }))],
  ["sequence update", (p) => replaceScene(p, applyPresentationStep(scene(p, "architecture"), {
    id: "s2", type: "update", objects: [{ ...object(p, "architecture", "api"), text: "Route" }],
  }))],
  ["sequence reveal", (p) => replaceScene(p, applyPresentationStep(scene(p, "marketing"), { id: "s3", type: "reveal", targetId: "takeaway" }))],
  ["sequence context", (p) => replaceScene(p, applyPresentationStep(scene(p, "architecture"), { id: "s4", type: "context", lesson }))],
  ["add and delete a scene", (p) => {
    p.scenes = p.scenes.filter((s) => s.id !== "mathematics");
    p.scenes.splice(1, 0, { id: "fresh", title: "Fresh", subtitle: "", kind: "slide", objects: [], connections: [] });
    p.cues = p.cues.filter((c) => c.sceneId !== "mathematics");
  }],
];

describe("applyDiff", () => {
  it.each(mutations)("reproduces next exactly: %s", (_name, mutate) => {
    const doc = seeded();
    const { next, result } = commit(doc, mutate);
    expect(result.changed).toBe(true);
    expect(result.skipped).toEqual([]);
    const plain = toPlain(doc);
    expect(canonicalProject(strip(plain))).toBe(canonicalProject(strip(next)));
    expect(plain.updatedAt).not.toBe(FIXED);
    expect(ProjectSchema.safeParse(plain).success).toBe(true);
  });

  it("stays exact when every mutation is applied in sequence", () => {
    const doc = seeded();
    // Destructive edits last so later sequence steps still find their sources.
    const destructive = (name: string) => name.startsWith("delete") || name.startsWith("add and delete");
    const ordered = [...mutations.filter(([n]) => !destructive(n)), ...mutations.filter(([n]) => destructive(n))];
    for (const [, mutate] of ordered) {
      const { next } = commit(doc, mutate);
      expect(same(toPlain(doc), next)).toBe(true);
    }
  });

  it("returns changed:false and emits no update when nothing differs", () => {
    const doc = seeded();
    const spy = vi.fn();
    doc.on("update", spy);
    const plain = toPlain(doc);
    expect(applyDiff(doc, plain, structuredClone(plain), origin())).toEqual({ changed: false, skipped: [] });
    // View state and updatedAt are ignored.
    const viewOnly = structuredClone(plain);
    viewOnly.updatedAt = new Date().toISOString();
    viewOnly.scenes[2] = { ...viewOnly.scenes[2]!, viewport: { x: 50, y: 0, zoom: 1.5 }, activeAreaId: "start" };
    expect(applyDiff(doc, plain, viewOnly, origin()).changed).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("skips edits to an object a peer deleted", () => {
    const [a, b] = pair();
    const stale = toPlain(b);
    commit(a, (p) => {
      const s = scene(p, "marketing");
      s.objects = s.objects.filter((o) => o.id !== "revenue");
      p.cues = p.cues.filter((c) => c.targetId !== "revenue");
    });
    sync(a, b);
    const next = structuredClone(stale);
    object(next, "marketing", "revenue").label = "Sales";
    object(next, "marketing", "conversion").label = "Conversion";
    let result: ReturnType<typeof applyDiff> | undefined;
    expect(() => { result = applyDiff(b, stale, next, origin("client-b")); }).not.toThrow();
    expect(result!.skipped).toEqual([{ path: "scenes/marketing/objects/revenue", reason: "missing-in-doc" }]);
    expect(result!.changed).toBe(true);
    const plain = toPlain(b);
    expect(scene(plain, "marketing").objects.some((o) => o.id === "revenue")).toBe(false);
    expect(object(plain, "marketing", "conversion").label).toBe("Conversion");
  });
});

describe("concurrent replicas", () => {
  it("keeps a move and a relabel of the same object", () => {
    const [a, b] = pair();
    commit(a, (p) => { object(p, "marketing", "revenue").x = 222; }, "client-a");
    commit(b, (p) => { object(p, "marketing", "revenue").label = "Sales"; }, "client-b");
    sync(a, b);
    const pa = toPlain(a), pb = toPlain(b);
    expect(canonicalProject(pa)).toBe(canonicalProject(pb));
    expect(object(pa, "marketing", "revenue")).toMatchObject({ x: 222, label: "Sales" });
  });

  it("repairs a connection to a concurrently deleted object identically on both sides", () => {
    const [a, b] = pair();
    commit(a, (p) => {
      const s = scene(p, "architecture");
      s.objects = s.objects.filter((o) => o.id !== "database");
      s.connections = s.connections.filter((c) => c.id !== "query");
    }, "client-a");
    commit(b, (p) => {
      scene(p, "architecture").connections.push({ id: "direct", source: "client", target: "database" });
    }, "client-b");
    sync(a, b);
    const ra = repairProject(toPlain(a)), rb = repairProject(toPlain(b));
    expect(canonicalProject(ra.project)).toBe(canonicalProject(rb.project));
    expect(ProjectSchema.safeParse(ra.project).success).toBe(true);
    expect(scene(ra.project, "architecture").connections.map((c) => c.id)).toEqual(["request"]);
    expect(ra.issues.some((issue) => issue.includes("direct"))).toBe(true);
  });

  it("converges on a same-field conflict", () => {
    const [a, b] = pair();
    commit(a, (p) => { object(p, "marketing", "revenue").label = "From A"; }, "client-a");
    commit(b, (p) => { object(p, "marketing", "revenue").label = "From B"; }, "client-b");
    sync(a, b);
    const la = object(toPlain(a), "marketing", "revenue").label;
    expect(["From A", "From B"]).toContain(la);
    expect(object(toPlain(b), "marketing", "revenue").label).toBe(la);
  });

  it("keeps the same last 2000 strokes after concurrent ink appends", () => {
    const [a, b] = pair();
    const append = (prefix: string) => (p: Project) => {
      const s = scene(p, "architecture");
      s.ink = Array.from({ length: 1500 }, (_, i) => stroke(`${prefix}-${i}`));
    };
    commit(a, append("a"), "client-a");
    commit(b, append("b"), "client-b");
    sync(a, b);
    const ra = repairProject(toPlain(a)), rb = repairProject(toPlain(b));
    const ink = scene(ra.project, "architecture").ink!;
    expect(ink).toHaveLength(INK_MAX_STROKES);
    expect(ink.map((s) => s.id)).toEqual(scene(rb.project, "architecture").ink!.map((s) => s.id));
    expect(canonicalProject(ra.project)).toBe(canonicalProject(rb.project));
  });
});

describe("repairProject", () => {
  const broken = (edit: (p: Project) => void): Project => {
    const p = fixture();
    edit(p);
    return p;
  };
  const cases: [string, Project, (r: Project, issues: string[]) => void][] = [
    ["ragged cells", broken((p) => { object(p, "mathematics", "matrix-a").cells = [[1, 2], [3]]; }), (r) => {
      expect(object(r, "mathematics", "matrix-a").cells).toEqual([[1, 2], [3, 0]]);
    }],
    ["dangling anchor", broken((p) => {
      const s = scene(p, "marketing");
      s.objects = s.objects.filter((o) => o.id !== "channels");
      s.objects.push({ id: "logo", kind: "image", label: "Logo", x: 300, y: 410, width: 80, height: 60, src: "https://example.com/a.png", anchor: { targetId: "channels", kind: "x-axis" } });
      s.objects.push({ id: "badge", kind: "image", label: "Badge", x: 500, y: 420, width: 80, height: 60, src: "https://example.com/b.png", anchor: { targetId: "revenue", kind: "x-axis" } });
    }), (r) => {
      expect(object(r, "marketing", "logo")).toMatchObject({ x: 300, y: 410 });
      expect(object(r, "marketing", "logo").anchor).toBeUndefined();
      expect(object(r, "marketing", "badge")).toMatchObject({ x: 500, y: 420 });
      expect(object(r, "marketing", "badge").anchor).toBeUndefined();
    }],
    ["duplicate ids", broken((p) => {
      p.scenes.push(structuredClone(p.scenes[0]!));
      const s = scene(p, "architecture");
      s.objects.push({ ...s.objects[0]!, label: "Duplicate" });
      s.connections.push({ ...s.connections[0]! });
      s.areas!.push({ ...s.areas![0]!, label: "Again" });
    }), (r) => {
      expect(r.scenes).toHaveLength(3);
      expect(object(r, "architecture", "client").label).toBe("Web client");
      expect(scene(r, "architecture").objects).toHaveLength(3);
      expect(scene(r, "architecture").connections).toHaveLength(2);
      expect(scene(r, "architecture").areas).toHaveLength(1);
    }],
    ["zero scenes", broken((p) => { p.scenes = []; }), (r) => {
      expect(r.scenes.map((s) => s.id)).toEqual(["scene-1"]);
      expect(r.cues).toEqual([]);
    }],
    ["cue to a missing target", broken((p) => {
      p.cues.push({ id: "cue-ghost", sceneId: "marketing", phrase: "ghost", targetId: "ghost", action: "point" });
      p.cues.push({ id: "cue-lost", sceneId: "nowhere", phrase: "lost", targetId: "revenue", action: "point" });
    }), (r) => {
      expect(r.cues.map((c) => c.id)).toEqual(["cue-revenue", "cue-takeaway", "cue-equation"]);
    }],
    ["odd ink points", broken((p) => {
      scene(p, "marketing").ink!.push(stroke("odd", [1, 2, 3]), stroke("short", [1]));
    }), (r) => {
      expect(scene(r, "marketing").ink!.map((s) => s.id)).toEqual(["ink-a", "ink-b"]);
    }],
  ];
  it.each(cases)("is idempotent and deterministic: %s", (_name, input, check) => {
    expect(ProjectSchema.safeParse(input).success).toBe(false);
    const first = repairProject(structuredClone(input));
    const again = repairProject(structuredClone(input));
    expect(canonicalProject(again.project)).toBe(canonicalProject(first.project));
    expect(again.issues).toEqual(first.issues);
    expect(first.issues.length).toBeGreaterThan(0);
    expect(ProjectSchema.safeParse(first.project).success).toBe(true);
    const second = repairProject(first.project);
    expect(canonicalProject(second.project)).toBe(canonicalProject(first.project));
    expect(second.issues).toEqual([]);
    check(first.project, first.issues);
  });

  it("uses the route id and strips view state", () => {
    const { project, issues } = repairProject(fixture(), "route-id");
    expect(project.id).toBe("route-id");
    expect(project.scenes[2]!.viewport).toBeUndefined();
    expect(project.scenes[2]!.activeAreaId).toBeUndefined();
    expect(issues).toEqual([]);
  });
});

describe("undo with LocalOrigin", () => {
  it("undoes only this replica's commit", () => {
    const [a, b] = pair();
    const undo = new Y.UndoManager(a.getMap(PROJECT_ROOT), { trackedOrigins: new Set([LocalOrigin]), captureTimeout: 800 });
    commit(a, (p) => { object(p, "marketing", "revenue").x = 333; }, "client-a");
    sync(a, b);
    commit(b, (p) => { object(p, "marketing", "conversion").label = "Peer label"; }, "client-b");
    sync(a, b);
    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    const plain = toPlain(a);
    expect(object(plain, "marketing", "revenue").x).toBe(70);
    expect(object(plain, "marketing", "conversion").label).toBe("Peer label");
  });

  it("groups commits by capture timeout", () => {
    // lib0 captures Date.now at module load, so vi.useFakeTimers cannot move UndoManager's clock;
    // instead age the manager's last-change timestamp by more than the timeout between commits.
    const run = (captureTimeout: number) => {
      const doc = seeded();
      const undo = new Y.UndoManager(doc.getMap(PROJECT_ROOT), { trackedOrigins: new Set([LocalOrigin]), captureTimeout });
      for (const x of [100, 200, 300]) {
        commit(doc, (p) => { object(p, "marketing", "revenue").x = x; });
        undo.lastChange -= 900;
      }
      return undo.undoStack.length;
    };
    expect(run(800)).toBe(3);
    expect(run(Number.MAX_SAFE_INTEGER)).toBe(1);
  });
});

describe("observeProject", () => {
  it("reports touched scenes, sections and origin locality", () => {
    const [a, b] = pair();
    const seen: ProjectChange[] = [];
    const stop = observeProject(b, (change) => seen.push(change));
    commit(b, (p) => {
      object(p, "marketing", "revenue").x = 1;
      replaceScene(p, addInkStroke(scene(p, "architecture"), stroke("ink-z")));
    }, "client-b");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.local).toBe(true);
    expect(seen[0]!.origin).toBeInstanceOf(LocalOrigin);
    expect(seen[0]!.clientIds).toEqual(new Set([b.clientID]));
    expect([...seen[0]!.scenes.keys()].sort()).toEqual(["architecture", "marketing"]);
    expect([...seen[0]!.scenes.get("marketing")!]).toEqual(["objects"]);
    expect([...seen[0]!.scenes.get("architecture")!]).toEqual(["ink"]);
    expect(seen[0]!.project).toBe(false);

    commit(a, (p) => {
      p.title = "Remote title";
      scene(p, "mathematics").subtitle = "Changed";
      scene(p, "mathematics").lesson = { domain: "math", sourceIds: [], completedCueIds: [] };
    }, "client-a");
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
    expect(seen).toHaveLength(2);
    expect(seen[1]!.local).toBe(false);
    expect(seen[1]!.origin).toBeNull();
    expect(seen[1]!.clientIds).toEqual(new Set([a.clientID]));
    expect(seen[1]!.project).toBe(true);
    expect(seen[1]!.scenes.get("mathematics")).toEqual(new Set(["meta", "lesson"]));
    stop();
    commit(b, (p) => { p.title = "Unobserved"; }, "client-b");
    expect(seen).toHaveLength(2);
  });
});
