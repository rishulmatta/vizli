import { test, expect } from "@playwright/test";
import { createDemoProject, type Scene } from "../packages/shared/src/index";

test("retrieved image renders on the axis, follows its chart, detaches on drag, and undoes", async ({
  page,
}) => {
  const project = createDemoProject();
  project.id = `e2e-search-${crypto.randomUUID()}`;
  await page.addInitScript(
    (p) => localStorage.setItem("vizli.project.v1", JSON.stringify(p)),
    project,
  );
  const src = "https://images.example.test/apple.png";
  await page.route(src, (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  // The external service and session are tested on the server. This fixture
  // verifies the browser's action boundary without depending on public search.
  await page.routeWebSocket("**/api/session", (socket) => {
    let scene: Scene;
    let revision: number;
    socket.send(JSON.stringify({ type: "ready", mode: "demo" }));
    socket.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === "scene") {
        scene = message.scene;
        revision = message.revision;
      }
      if (message.type === "cue")
        socket.send(
          JSON.stringify({
            type: "action",
            action: {
              id: "search-result",
              type: "add_image",
              sceneId: scene.id,
              revision,
              reason: "Found an apple image on Wikimedia Commons.",
              object: {
                id: "searched-apple",
                kind: "image",
                label: "Apple",
                x: 0,
                y: 0,
                width: 100,
                height: 100,
                src,
                anchor: { kind: "x-axis", targetId: "channels" },
                imageSource: {
                  query: "apple fruit",
                  provider: "Wikimedia Commons",
                  pageUrl:
                    "https://commons.wikimedia.org/wiki/File:Red_Apple.jpg",
                  attribution: "Test photographer",
                  license: "CC BY-SA",
                },
              },
            },
          }),
        );
    });
  });
  await page.goto("/");
  await page.getByTestId("cue-input").fill("An apple on the x axis");
  await page.getByTestId("cue-submit").click();
  const apple = page.locator('[data-object-id="searched-apple"]');
  await expect(apple.locator("img")).toBeVisible();
  await expect(page.getByTestId("image-source-link")).toHaveAttribute(
    "href",
    "https://commons.wikimedia.org/wiki/File:Red_Apple.jpg",
  );
  await expect(page.getByTestId("image-anchor-status")).toContainText(
    "Anchored to x-axis",
  );
  const chart = page.locator('[data-object-id="channels"]');
  const before = (await apple.boundingBox())!;
  await chart.click({ position: { x: 12, y: 12 } });
  await page.getByRole("button", { name: "Delete selected object" }).click();
  await expect(chart).toHaveCount(0);
  await apple.click();
  await expect(page.getByTestId("image-anchor-status")).toHaveCount(0);
  expect((await apple.boundingBox())!.x).toBeCloseTo(before.x, 0);
  await page.getByTestId("undo-button").click();
  await expect(chart).toBeVisible();
  await chart.scrollIntoViewIfNeeded();
  const beforeMove = (await apple.boundingBox())!;
  const chartBefore = (await chart.boundingBox())!;
  await page.mouse.move(chartBefore.x + 12, chartBefore.y + 12);
  await page.mouse.down();
  await page.mouse.move(chartBefore.x + 42, chartBefore.y + 32, { steps: 8 });
  await page.mouse.up();
  const after = (await apple.boundingBox())!;
  expect(after.x - beforeMove.x).toBeCloseTo(30, 0);
  expect(after.y - beforeMove.y).toBeCloseTo(20, 0);
  await page.mouse.move(after.x + after.width / 2, after.y + after.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    after.x + after.width / 2 + 25,
    after.y + after.height / 2 - 25,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect(page.getByTestId("image-anchor-status")).toHaveCount(0);
  await page.getByTestId("undo-button").click();
  await apple.click();
  await expect(page.getByTestId("image-anchor-status")).toBeVisible();
  await page.getByTestId("undo-button").click();
  await page.getByTestId("undo-button").click();
  await expect(apple).toHaveCount(0);
});
