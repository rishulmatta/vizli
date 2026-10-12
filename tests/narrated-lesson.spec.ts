import { test, expect, type Page } from "@playwright/test";
import { proxySession, savedViewport } from "./ui";
import {
  createDemoProject,
  createPluginObject,
  type Scene,
} from "../packages/shared/src/index";
async function saved(page: Page): Promise<Scene> {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem("vizli.project.v1")!).scenes[0],
  );
}
async function cue(page: Page, text: string) {
  await page.getByTestId("cue-input").fill(text);
  await page.getByTestId("cue-submit").click();
}
test("teacher narration builds symbolic matrices, colours row attention, pans and derives nine products", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const project = createDemoProject();
  project.id = `e2e-lesson-${crypto.randomUUID()}`;
  project.cues = [];
  project.scenes = [
    {
      id: "lesson-board",
      title: "Matrix lesson",
      subtitle: "",
      kind: "math",
      layout: "whiteboard",
      viewport: { x: 0, y: 0, zoom: 1 },
      objects: [],
      connections: [],
    },
  ];
  await page.addInitScript((p) => {
    if (!localStorage.getItem("vizli.project.v1"))
      localStorage.setItem("vizli.project.v1", JSON.stringify(p));
  }, project);
  await page.goto("/");
  await cue(page, "Today we'll learn about matrix multiplications");
  await expect
    .poll(async () => (await saved(page)).objects.length)
    .toBeGreaterThan(0);
  await expect(page.getByTestId("presentation-playback")).toHaveAttribute(
    "data-state",
    "completed",
  );
  await cue(page, "There are two metrics A and B, A is 3*2 and B is 2*3");
  await expect
    .poll(
      async () =>
        (await saved(page)).objects.filter((o) => o.kind === "matrix").length,
    )
    .toBe(2);
  await expect(page.getByTestId("presentation-playback")).toHaveAttribute(
    "data-state",
    "completed",
  );
  const matrices = (await saved(page)).objects.filter(
    (o) => o.kind === "matrix",
  );
  const a = matrices.find((o) => o.value === "A" || o.label === "Matrix A")!,
    b = matrices.find((o) => o.value === "B" || o.label === "Matrix B")!;
  expect(a.cells).toHaveLength(3);
  expect(a.cells![0]).toHaveLength(2);
  expect(b.cells).toHaveLength(2);
  expect(b.cells![0]).toHaveLength(3);
  expect(a.cells!.flat().every((v) => typeof v === "string")).toBe(true);
  await cue(page, "Point to the first row of A");
  await expect(
    page.locator(
      `[data-testid="visual-effect"][data-target-id="${a.id}:row:0"]`,
    ),
  ).toBeVisible();
  await cue(page, "Highlight the second row of A in blue");
  const highlighted = page.locator(
    `[data-testid="visual-effect"][data-target-id="${a.id}:row:1"]`,
  );
  await expect(highlighted).toBeVisible();
  await expect(highlighted.locator("rect").first()).toHaveAttribute(
    "stroke",
    /#(?:2563eb|3b82f6|0000ff)/i,
  );
  const before = (await savedViewport(page, (await saved(page)).id)).y;
  await cue(page, "Now let's scroll down to see the multiplication");
  await expect
    .poll(async () => (await savedViewport(page, (await saved(page)).id)).y)
    .toBeGreaterThan(before);
  await expect(page.getByTestId("presentation-playback")).toHaveAttribute(
    "data-state",
    "completed",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await cue(page, "The rows can be multiplied with the columns of B");
  await expect
    .poll(
      async () =>
        (await saved(page)).objects
          .find((o) => o.label === "Product AB")
          ?.cells?.flat()
          .filter((v) => v !== "").length ?? 0,
      { timeout: 60000 },
    )
    .toBe(9);
  await expect(page.getByTestId("presentation-playback")).toHaveAttribute(
    "data-state",
    "completed",
    { timeout: 60000 },
  );
  const complete = await saved(page);
  expect(
    complete.objects.filter((o) => o.kind === "matrix").length,
  ).toBeGreaterThanOrEqual(3);
  expect(
    complete.objects
      .find((o) => o.label === "Product AB")
      ?.math?.expressions?.flat(),
  ).toHaveLength(9);
  expect(complete.objects.some((o) => o.plugin?.id === "math.equation")).toBe(
    true,
  );
  expect(complete.objects.find((o) => o.id === a.id)?.cells).toEqual(a.cells);
  expect(complete.objects.find((o) => o.id === b.id)?.cells).toEqual(b.cells);
  const count = complete.objects.length;
  await cue(page, "The rows can be multiplied with the columns of B");
  await page.getByTestId("activity-toggle").click();
  await expect(page.getByText(/already|complete/i).first()).toBeVisible();
  expect((await saved(page)).objects.length).toBe(count);
  await page.reload();
  expect((await saved(page)).objects.length).toBe(count);
});

test("non-maths sequences use the same player and a manual edit cancels remaining steps", async ({
  page,
}) => {
  const project = createDemoProject();
  project.id = `e2e-domain-playback-${crypto.randomUUID()}`;
  project.cues = [];
  project.scenes = [
    {
      id: "cloud-playback",
      title: "Cloud walkthrough",
      subtitle: "",
      kind: "architecture",
      layout: "whiteboard",
      objects: [],
      connections: [],
    },
  ];
  await page.addInitScript((p) => {
    if (!localStorage.getItem("vizli.project.v1"))
      localStorage.setItem("vizli.project.v1", JSON.stringify(p));
  }, project);
  await proxySession(page, (m, session) => {
      if (m.type !== "cue") return;
        session.reply({
            type: "action",
            action: {
              id: "cloud-sequence-action",
              type: "sequence",
              sceneId: session.sceneId,
              revision: 0,
              reason: "Generic cloud presentation",
              sequence: {
                id: "cloud-walkthrough",
                domain: "cloud.aws",
                steps: [
                  {
                    id: "introduce",
                    type: "insert",
                    objects: [
                      createPluginObject("cloud.aws", "service-one", 120, 220),
                    ],
                    entrance: "draw",
                    durationMs: 5000,
                  },
                  {
                    id: "point",
                    type: "attention",
                    targets: ["service-one:part:service"],
                    style: "point",
                    color: "#dc2626",
                    durationMs: 1500,
                  },
                  {
                    id: "next",
                    type: "insert",
                    objects: [
                      createPluginObject("uml.class", "class-later", 600, 220),
                    ],
                    entrance: "draw",
                    durationMs: 1000,
                  },
                ],
              },
            },
          });
      return true;
  });
  await page.goto("/");
  await cue(page, "Show the cloud workflow");
  const status = page.getByTestId("presentation-playback");
  await expect(status).toHaveAttribute("data-state", "playing");
  await page.getByTestId("playback-pause").click();
  await expect(status).toHaveAttribute("data-state", "paused");
  await page.locator('[data-object-id="service-one"]').click();
  await page.getByTestId("inspector-label").fill("Edited service");
  await expect(status).toHaveAttribute("data-state", "cancelled");
  expect((await saved(page)).objects.map((o) => o.id)).toEqual(["service-one"]);
  await page.getByTestId("undo-button").click();
  await page.getByTestId("undo-button").click();
  await expect.poll(async () => (await saved(page)).objects.length).toBe(0);
});
