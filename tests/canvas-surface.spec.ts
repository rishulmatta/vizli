import { test, expect } from "@playwright/test";
import { createDemoProject } from "../packages/shared/src/index";
import { savedViewport } from "./ui";

test("existing slide becomes an expanding whiteboard and hand drag preserves objects", async ({
  page,
}) => {
  const project = createDemoProject();
  project.id = `e2e-surface-${crypto.randomUUID()}`;
  await page.addInitScript((p) => {
    if (!localStorage.getItem("vizli.project.v1"))
      localStorage.setItem("vizli.project.v1", JSON.stringify(p));
  }, project);
  await page.goto("/");
  const canvas = page.getByTestId("scene-canvas");
  const saved = () =>
    page.evaluate(
      () => JSON.parse(localStorage.getItem("vizli.project.v1")!).scenes[0],
    );
  const original = (await saved()).objects;
  await expect(canvas).toHaveAttribute("data-layout", "slide");
  await page.getByTestId("surface-whiteboard").click();
  await expect(canvas).toHaveAttribute("data-layout", "whiteboard");
  const metric = page.locator('[data-object-id="revenue"]');
  const box = (await metric.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 170, y + 70, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => (await savedViewport(page, project.scenes[0].id)).x)
    .toBeGreaterThan(100);
  expect((await saved()).objects).toEqual(original);
  // Travel several original page widths: content must stay in world coordinates.
  await page.mouse.move(800, 380);
  await page.mouse.wheel(4500, 0);
  await expect
    .poll(async () => (await savedViewport(page, project.scenes[0].id)).x)
    .toBeGreaterThan(3000);
  expect((await saved()).objects).toEqual(original);
  await page.getByTestId("surface-slide").click();
  await expect(canvas).toHaveAttribute("data-layout", "slide");
  expect((await saved()).objects).toEqual(original);
  await page.getByTestId("surface-whiteboard").click();
  await expect(canvas).toHaveAttribute("data-layout", "whiteboard");
  await expect
    .poll(async () => Number(await canvas.getAttribute("data-camera-x")))
    .toBeGreaterThan(3000);
  await page.getByTestId("board-zoom-reset").click();
  await expect(canvas).toHaveAttribute("data-camera-x", "0");
  await expect(metric).toBeVisible();
  expect((await saved()).objects).toEqual(original);
  await page.reload();
  await expect(canvas).toHaveAttribute("data-layout", "whiteboard");
});
