import {selectScene, openScenes, openProjectMenu, closeProjectMenu} from "./ui";
import { test, expect } from "@playwright/test";
import { createDemoProject } from "../packages/shared/src/index";

test.beforeEach(async ({ page }) => {
  const project = createDemoProject();
  project.id = `e2e-${crypto.randomUUID()}`;
  await page.addInitScript((project) => {
    if (!localStorage.getItem("vizli.project.v1"))
      localStorage.setItem("vizli.project.v1", JSON.stringify(project));
  }, project);
});

test("studio renders all three scene types and processes a visual cue", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByTestId("scene-canvas")).toBeVisible();
  await expect(page.getByTestId("scene-button-marketing")).toHaveCount(0);
  await page.getByTestId("cue-input").fill("point to revenue");
  await page.getByTestId("cue-submit").click();
  await expect(page.getByTestId("visual-effect")).toBeVisible();
  await expect(page.getByTestId("visual-effect")).toHaveAttribute(
    "data-target-id",
    "revenue",
  );
  await selectScene(page,"mathematics");
  await expect(page.locator('[data-object-id="matrix-a"]')).toBeVisible();
  await expect(page.getByTestId("visual-effect")).toHaveCount(0);
  await page
    .getByTestId("cue-input")
    .fill("highlight the second row of matrix a");
  await page.getByTestId("cue-submit").click();
  await expect(page.getByTestId("visual-effect")).toHaveAttribute(
    "data-target-id",
    "matrix-a:row:1",
  );
  await selectScene(page,"architecture");
  await expect(page.locator('[data-object-id="api"]')).toBeVisible();
  expect(errors).toEqual([]);
});

test("editing, undo, and presentation mode remain usable", async ({ page }) => {
  await page.goto("/");
  await selectScene(page,"marketing");
  await page.locator('[data-object-id="revenue"]').click();
  const value = page.getByTestId("inspector-value");
  await expect(value).toHaveValue("$3.2M");
  await value.fill("$4.1M");
  await value.blur();
  await expect(page.locator('[data-object-id="revenue"]')).toContainText(
    "$4.1M",
  );
  await page.getByTestId("undo-button").click();
  await expect(page.locator('[data-object-id="revenue"]')).toContainText(
    "$3.2M",
  );
  await page.getByTestId("mode-presenting").click();
  await expect(page.getByTestId("scene-canvas")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("mode-editing")).toBeVisible();
});

test("project persistence validates unsafe payloads", async ({ request }) => {
  const response = await request.get("/api/projects/default");
  expect(response.ok()).toBeTruthy();
  const project = await response.json();
  expect(project.scenes.length).toBeGreaterThanOrEqual(3);
  const malformed = await request.put("/api/projects/default", {
    data: { ...project, scenes: [] },
  });
  expect(malformed.status()).toBeGreaterThanOrEqual(400);
  expect(malformed.status()).toBeLessThan(500);
  const status = await request.get("/api/status");
  const body = await status.json();
  expect(body.mode).toBe("demo");
  expect(body.speechConfigured).toBe(false);
});

test("narrow workspace avoids horizontal page overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.getByTestId("scene-canvas")).toBeVisible();
  const dimensions = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width + 1);
});

test("rehearsal remembers a selected object and survives reload", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByTestId("mode-rehearsing").click();
  await page.locator('[data-object-id="acquisition"]').click();
  await page.getByLabel("Rehearsal phrase").fill("our efficiency breakthrough");
  await page.getByLabel("Cue action").selectOption("highlight");
  await page.getByRole("button", { name: "Remember", exact: true }).click();
  await page.reload();
  await page.getByTestId("cue-input").fill("our efficiency breakthrough");
  await page.getByTestId("cue-submit").click();
  await expect(page.getByTestId("visual-effect")).toHaveAttribute(
    "data-target-id",
    "acquisition",
  );
});

test("idea creation adds an editable scene with honest demo labelling", async ({
  page,
}) => {
  await page.goto("/");
  await openProjectMenu(page);
  await page.getByTestId("create-from-idea").click();
  await page.getByTestId("scene-prompt").fill("Explain a browser request");
  await page.getByLabel("Generated scene type").selectOption("architecture");
  await page.getByTestId("generate-scene").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await closeProjectMenu(page);
  await openScenes(page);
  await expect(page.locator(".scene-tile")).toHaveCount(4);
  await page.getByRole("button",{name:"Close scenes",exact:true}).click();
  await expect(page.locator(".react-flow")).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "editable example template",
  );
});

test("image upload is rendered and exported project remains editable", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Add object" }).click();
  await page.getByTestId("add-image").click();
  const pixel = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  await page
    .locator('input[type=file][accept^="image/"]')
    .setInputFiles({ name: "pixel.png", mimeType: "image/png", buffer: pixel });
  await expect(page.locator(".viz-image-content img")).toBeVisible();
  const downloadEvent = page.waitForEvent("download");
  await openProjectMenu(page);
  await page.getByTestId("project-export").click();
  const download = await downloadEvent;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const project = JSON.parse(Buffer.concat(chunks).toString());
  expect(
    project.scenes[0].objects.some(
      (object: { kind: string; src?: string }) =>
        object.kind === "image" && object.src?.startsWith("data:image/png"),
    ),
  ).toBeTruthy();
});

test("missing cloud and microphone configuration are explicit", async ({
  page,
}) => {
  await page.goto("/");
  await openProjectMenu(page);
  await page.getByRole("button", { name: "Cloud", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Cloud sync has not been configured",
  );
  await page.keyboard.press("Escape");
  await page.getByTestId("microphone-toggle").click();
  await expect(page.getByRole("dialog")).toContainText("Not configured");
  await expect(page.getByTestId("microphone-toggle")).toHaveAttribute(
    "aria-label",
    "Start microphone",
  );
});
