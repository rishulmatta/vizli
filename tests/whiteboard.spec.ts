import {selectScene, newWhiteboard, savedViewport} from "./ui";
import { test, expect, type Page } from "@playwright/test";
import { createDemoProject, type Scene } from "../packages/shared/src/index";

async function currentBoard(page: Page): Promise<Scene> {
  return page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem("vizli.project.v1")!);
    return project.scenes.find((scene: { layout?: string }) => scene.layout === "whiteboard");
  });
}
async function cue(page: Page, text: string) {
  await page.getByTestId("cue-input").fill(text);
  await page.getByTestId("cue-submit").click();
}
test.beforeEach(async ({ page }) => {
  const project = createDemoProject();
  project.id = `e2e-board-${crypto.randomUUID()}`;
  await page.addInitScript(project => {
    if (!localStorage.getItem("vizli.project.v1")) localStorage.setItem("vizli.project.v1", JSON.stringify(project));
  }, project);
});

test("whiteboard retains drawings while navigating, generating, returning and moving objects", async ({ page }) => {
  await page.goto("/");
  await newWhiteboard(page);
  const canvas = page.getByTestId("scene-canvas");
  await expect(canvas).toHaveAttribute("data-layout", "whiteboard");
  await cue(page, "draw a software architecture");
  await expect.poll(async () => (await currentBoard(page)).objects.length).toBeGreaterThan(0);
  const first = await currentBoard(page);
  const client = first.objects.find(object => object.label === "Web client")!;
  expect(client).toBeTruthy();
  await expect(page.locator(`[data-object-id="${client.id}"]`)).toBeVisible();
  await cue(page, "let's go right");
  await expect(canvas).toHaveAttribute("data-camera-x", "1320");
  expect((await currentBoard(page)).objects).toEqual(first.objects);
  await cue(page, "draw a matrix lesson");
  await expect.poll(async () => (await currentBoard(page)).objects.length).toBeGreaterThan(first.objects.length);
  const expanded = await currentBoard(page);
  expect(expanded.objects.filter(object => !first.objects.some(prior => prior.id === object.id)).every(object => object.x >= 1320)).toBe(true);
  await cue(page, "go to Start");
  await expect(canvas).toHaveAttribute("data-camera-x", "0");
  await cue(page, "highlight Web client");
  await expect(page.getByTestId("visual-effect")).toHaveAttribute("data-target-id", client.id);
  await cue(page, "move Web client right");
  await expect.poll(async () => (await currentBoard(page)).objects.find(object => object.id === client.id)?.x).toBe(client.x + 200);
  await page.getByTestId("undo-button").click();
  await expect.poll(async () => (await currentBoard(page)).objects.find(object => object.id === client.id)?.x).toBe(client.x);
  // Old finite slide scenes remain available alongside the expanding board.
  await selectScene(page,"marketing");
  await expect(page.locator('[data-object-id="revenue"]')).toBeVisible();
});

test("whiteboard camera and area names persist and zoomed editing uses world coordinates", async ({ page }) => {
  await page.goto("/");
  await newWhiteboard(page);
  await page.getByTestId("board-pan-right").click();
  const canvas = page.getByTestId("scene-canvas");
  await expect(canvas).toHaveAttribute("data-camera-x", "1320");
  await page.getByTestId("board-area-name").fill("Database");
  await page.getByTestId("board-area-rename").click();
  await page.getByRole("button", { name: "Add object", exact: true }).click();
  await page.getByTestId("add-text").click();
  await expect.poll(async () => (await currentBoard(page)).objects.length).toBe(1);
  const board = await currentBoard(page), original = board.objects[0]!;
  expect(original.x).toBeGreaterThanOrEqual(1320);
  await page.getByTestId("board-zoom-in").click();
  await expect.poll(async () => Number(await canvas.getAttribute("data-camera-zoom"))).toBeGreaterThan(1);
  await expect.poll(async () => (await savedViewport(page, board.id)).zoom).toBeGreaterThan(1);
  const camera = await savedViewport(page, board.id);
  const object = page.locator(`[data-object-id="${original.id}"]`);
  await object.scrollIntoViewIfNeeded();
  const box = (await object.boundingBox())!, canvasBox = (await canvas.boundingBox())!;
  const movement = 60;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + movement, box.y + box.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await currentBoard(page)).objects[0]!.x).toBeCloseTo(original.x + movement / (canvasBox.width / 1200 * camera.zoom), 0);
  const saved = await currentBoard(page);
  const savedCamera = await savedViewport(page, board.id);
  await page.reload();
  await selectScene(page,board.id);
  await expect(canvas).toHaveAttribute("data-layout", "whiteboard");
  expect(await savedViewport(page, board.id)).toEqual(savedCamera);
  expect((await currentBoard(page)).areas?.some(area => area.label === "Database")).toBe(true);
  await cue(page, "go to Start");
  await expect(canvas).toHaveAttribute("data-camera-x", "0");
  await cue(page, "go to Database");
  await expect(canvas).toHaveAttribute("data-camera-x", "1320");
});
