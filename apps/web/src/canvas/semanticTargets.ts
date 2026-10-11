/** DOM lookup is independent of rendering domains and motion adapters. */
export function targetElements(root: HTMLElement | null, targetId?: string) {
  if (!root || !targetId) return [];
  const elements = Array.from(
    root.querySelectorAll<HTMLElement | SVGElement>("[data-target-id]"),
  ).filter((e) => e.dataset.testid !== "visual-effect");
  const direct = elements.filter((e) => e.dataset.targetId === targetId);
  if (direct.length) return direct;
  return Array.from(
    root.querySelectorAll<HTMLElement | SVGElement>("[data-target-groups]"),
  ).filter((element) =>
    (element.dataset.targetGroups ?? "").split(/\s+/).includes(targetId),
  );
}
