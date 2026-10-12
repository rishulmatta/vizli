import { describe, it, expect } from "vitest";
import { createDemoProject, sameSignature, sequenceSourceSignature, stableJson, invalidateDerivedResults } from "@vizli/shared";

describe("source signatures across replicas", () => {
  const scene = createDemoProject().scenes[1];
  it("ignores key order and undefined fields", () => {
    const reordered = { ...scene, objects: scene.objects.map((o) => ({ ...Object.fromEntries(Object.entries(o).reverse()), extra: undefined })) } as unknown as typeof scene;
    expect(sequenceSourceSignature(reordered, ["matrix-a"])).toBe(sequenceSourceSignature(scene, ["matrix-a"]));
    expect(stableJson({ b: 1, a: { d: undefined, c: 2 } })).toBe('{"a":{"c":2},"b":1}');
  });
  it("accepts signatures stored before stable ordering and rejects changed sources", () => {
    const legacy = JSON.stringify([scene.objects.find((o) => o.id === "matrix-a")]);
    const current = sequenceSourceSignature(scene, ["matrix-a"]);
    expect(sameSignature(legacy, current)).toBe(true);
    const changed = { ...scene, objects: scene.objects.map((o) => (o.id === "matrix-a" ? { ...o, label: "B" } : o)) };
    expect(sameSignature(legacy, sequenceSourceSignature(changed, ["matrix-a"]))).toBe(false);
    expect(sameSignature(undefined, current)).toBe(false);
    expect(sameSignature("not json", current)).toBe(false);
  });
  it("keeps derived results visible after a key-order round trip", () => {
    const derived = { ...scene.objects[0], id: "derived", derivedFrom: { sourceIds: ["matrix-a"], sourceSignature: JSON.stringify([scene.objects.find((o) => o.id === "matrix-a")]) } };
    const reordered = { ...scene, objects: [...scene.objects.map((o) => Object.fromEntries(Object.entries(o).reverse()) as typeof o), derived] } as unknown as typeof scene;
    const result = invalidateDerivedResults(reordered);
    expect(result.objects.find((o) => o.id === "derived")?.hidden).not.toBe(true);
  });
});
