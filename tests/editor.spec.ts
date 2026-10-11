import {selectScene} from "./ui";
import { test, expect } from "@playwright/test";
import { createDemoProject } from "../packages/shared/src/index";
test.beforeEach(async ({ page }) => {
  const project = createDemoProject();
  project.id = `e2e-editor-${crypto.randomUUID()}`;
  await page.addInitScript(
    (p) => localStorage.setItem("vizli.project.v1", JSON.stringify(p)),
    project,
  );
});

test("matrix data applies atomically, rejects ragged rows, and undoes", async ({
  page,
}) => {
  await page.goto("/");
  await selectScene(page,"mathematics");
  await page.locator('[data-object-id="matrix-a"]').click();
  const values = page.getByTestId("matrix-values");
  await values.fill("7, 8\n9");
  await page.getByTestId("apply-data").click();
  await expect(page.getByRole("alert")).toContainText("equal-length");
  await values.fill("7, 8\n9, 10");
  await page.getByTestId("apply-data").click();
  await expect(page.locator('[data-object-id="matrix-a"]')).toContainText("10");
  await page.getByTestId("undo-button").click();
  await page.locator('[data-object-id="matrix-a"]').click();
  await expect(page.getByTestId("matrix-values")).toHaveValue("1, 2\n3, 4");
});

test("chart validates paired labels and scene metadata saves explicitly", async ({
  page,
}) => {
  await page.goto("/");
  await selectScene(page,"marketing");
  await page.locator('[data-object-id="channels"]').click();
  await page.getByTestId("chart-values").fill("10, 20");
  await page.getByTestId("chart-labels").fill("A");
  await page.getByTestId("apply-data").click();
  await expect(page.getByRole("alert")).toContainText("matching label");
  await page.getByTestId("chart-labels").fill("A, B");
  await page.getByTestId("apply-data").click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByTestId("scene-settings").click();
  await page.getByTestId("scene-title").fill("A clearer story");
  await page.getByTestId("scene-subtitle").fill("EDITED TITLE");
  await page.getByTestId("apply-scene-details").click();
  await expect(page.getByTestId("scene-canvas")).toContainText(
    "A clearer story",
  );
});

test("remembered cues can be removed with undo", async ({ page }) => {
  await page.goto("/");
  await selectScene(page,"marketing");
  await page.getByTestId("activity-toggle").click();
  const remove = page.getByTestId("remove-cue-cue-revenue");
  await expect(remove).toBeVisible();
  await remove.click();
  await expect(remove).toHaveCount(0);
  await page.getByTestId("undo-button").click();
  await expect(remove).toBeVisible();
});
