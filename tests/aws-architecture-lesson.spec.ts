import { test, expect, type Page } from "@playwright/test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createDemoProject, type Scene } from "../packages/shared/src/index";

async function saved(page: Page): Promise<Scene> {
  return page.evaluate(
    () => JSON.parse(localStorage.getItem("vizli.project.v1")!).scenes[0],
  );
}

async function cue(page: Page, text: string) {
  await page.getByTestId("cue-input").fill(text);
  await page.getByTestId("cue-submit").click();
}

async function openArchitectureBoard(page: Page) {
  const project = createDemoProject();
  project.id = `e2e-aws-flow-${crypto.randomUUID()}`;
  project.cues = [];
  project.scenes = [
    {
      id: "aws-meeting-board",
      title: "Regional API request flow",
      subtitle: "Meeting notes",
      kind: "architecture",
      layout: "whiteboard",
      viewport: { x: 0, y: 0, zoom: 1 },
      objects: [
        {
          id: "kept-agenda-note",
          kind: "text",
          label: "Meeting agenda",
          text: "Keep this note while adding the architecture.",
          x: 30,
          y: 25,
          width: 300,
          height: 90,
        },
      ],
      connections: [],
    },
    {
      id: "meeting-brief",
      title: "Meeting brief",
      subtitle: "Other scene",
      kind: "slide",
      objects: [],
      connections: [],
    },
  ];
  await page.addInitScript((seed) => {
    if (!localStorage.getItem("vizli.project.v1"))
      localStorage.setItem("vizli.project.v1", JSON.stringify(seed));
  }, project);
  await page.goto("/");
}

async function openArchitectureSlide(page: Page) {
  const project = createDemoProject();
  project.id = `e2e-aws-slide-${crypto.randomUUID()}`;
  project.cues = [];
  project.scenes = [
    {
      id: "aws-meeting-slide",
      title: "Regional API request flow",
      subtitle: "Meeting architecture",
      kind: "architecture",
      layout: "slide",
      objects: [],
      connections: [],
    },
  ];
  await page.addInitScript((seed) => {
    if (!localStorage.getItem("vizli.project.v1"))
      localStorage.setItem("vizli.project.v1", JSON.stringify(seed));
  }, project);
  await page.goto("/");
}

const meetingClauses = [
  "A client calls the API Gateway.",
  "Route 53 uses latency and geographic routing to choose the nearest region.",
  "The regional API sends the request to an Application Load Balancer.",
  "It spreads traffic across 5–12 EC2 nodes in an Auto Scaling group running our application API.",
  "The service writes to a PostgreSQL primary writer and reads from multiple read replicas.",
];

let cancellationDiagnostics: {
  phase: string;
  websocketFrames: string[];
  browserErrors: string[];
  path: string;
} | undefined;

test.afterEach(async ({ page }, info) => {
  if (!info.title.includes("explicit cancel")) return;
  if (info.status !== "passed" && cancellationDiagnostics) {
    const persistedEvents = await readFile(cancellationDiagnostics.path, "utf8").catch(() => "");
    await info.attach("aws-cancellation-debug.json", {
      body: Buffer.from(JSON.stringify({ ...cancellationDiagnostics, persistedEvents }, null, 2)),
      contentType: "application/json",
    });
  }
  cancellationDiagnostics = undefined;
});

test("meeting clauses build an honest AWS request flow incrementally and persist stable IDs", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await openArchitectureBoard(page);
  const playback = page.getByTestId("presentation-playback");

  await cue(page, meetingClauses[0]!);
  await expect(playback).toHaveAttribute("data-state", "playing");
  // The next finalized clause arrives while the first service symbols are still drawing.
  await cue(page, meetingClauses[1]!);
  await cue(page, meetingClauses[2]!);
  await cue(page, meetingClauses[3]!);
  await cue(page, meetingClauses[4]!);

  await expect
    .poll(async () => {
      const scene = await saved(page);
      return [
        scene.objects.some((o) => o.label === "Client"),
        scene.objects.some((o) => o.aws?.service === "apigateway"),
        scene.objects.some((o) => o.aws?.service === "route53"),
        scene.objects.some((o) => o.aws?.service === "alb"),
        scene.objects.some((o) => o.aws?.service === "ec2"),
        scene.objects.some((o) => o.label === "PostgreSQL primary writer"),
        scene.objects.some((o) => o.label === "Read replicas · multiple"),
      ];
    }, { timeout: 90_000 })
    .toEqual([true, true, true, true, true, true, true]);
  await expect(playback).toHaveAttribute("data-state", "completed", {
    timeout: 90_000,
  });

  const complete = await saved(page);
  const ids = complete.objects.map((o) => o.id);
  const edgePairs = complete.connections.map((e) => [e.source, e.target]);
  const bySuffix = (suffix: string) =>
    complete.objects.find((o) => o.id.endsWith(`-${suffix}`));
  const client = bySuffix("client")!;
  const gateway = bySuffix("gateway")!;
  const route53 = bySuffix("route53")!;
  const alb = bySuffix("alb")!;
  const compute = bySuffix("compute")!;
  const writer = bySuffix("postgres-writer")!;
  const replicas = bySuffix("read-replicas")!;

  expect(complete.id).toBe("aws-meeting-board");
  expect(ids).toContain("kept-agenda-note");
  expect(route53.text).toContain("Latency and geographic DNS routing");
  expect(
    complete.objects.find((o) => o.id.endsWith("-routing-note"))?.text,
  ).toContain("DNS is best effort; nearest region is not guaranteed.");
  expect(compute.label).toContain("5–12 nodes");
  expect(compute.text).toMatch(/regional API/i);
  expect(writer.label).toContain("PostgreSQL");
  expect(replicas.label).toContain("multiple");
  expect(replicas.label).not.toMatch(/\d/);
  expect(edgePairs).toEqual(
    expect.arrayContaining([
      [client.id, gateway.id],
      [route53.id, gateway.id],
      [gateway.id, alb.id],
      [alb.id, compute.id],
      [compute.id, writer.id],
      [compute.id, replicas.id],
      [writer.id, replicas.id],
    ]),
  );

  // These are the locally bundled official AWS symbols, and each image must load.
  const iconImages = page.locator(
    '[data-testid="scene-canvas"] img[data-aws-icon]',
  );
  await expect(iconImages).toHaveCount(6);
  await expect
    .poll(() => iconImages.evaluateAll((images) =>
      images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
    ))
    .toBe(true);
  await expect(
    page.locator('.viz-aws-card[data-aws-service="route53"]'),
  ).toBeVisible();
  await expect(
    page.locator('.viz-aws-card[data-aws-service="alb"]'),
  ).toBeVisible();
  await expect(
    page.locator('.viz-aws-card[data-aws-capacity-range="5–12"]'),
  ).toBeVisible();
  await expect(
    page.locator('.viz-aws-card[data-aws-capacity-range="5–12"] img'),
  ).toHaveAttribute("data-aws-icon", "/aws-icons/ec2-auto-scaling.svg");
  await expect(
    page.locator('.viz-aws-card[data-aws-replica-summary="multiple"]'),
  ).toBeVisible();

  // A completed clause is idempotent, and one undo removes the last grouped stage.
  await cue(page, meetingClauses[0]!);
  await expect(playback).toHaveAttribute("data-state", "completed", {
    timeout: 15_000,
  });
  expect((await saved(page)).objects.map((o) => o.id)).toEqual(ids);
  await page.getByTestId("undo-button").click();
  await expect
    .poll(async () => (await saved(page)).objects.some((o) => o.id === replicas.id))
    .toBe(false);
  expect((await saved(page)).objects.find((o) => o.id === "kept-agenda-note")).toBeTruthy();

  // Rebuild the database stage after undo, then confirm IDs and edges survive reload.
  await cue(page, meetingClauses[4]!);
  await expect
    .poll(async () => (await saved(page)).objects.some((o) => o.id === replicas.id))
    .toBe(true);
  await expect(playback).toHaveAttribute("data-state", "completed", {
    timeout: 20_000,
  });
  expect((await saved(page)).objects.map((o) => o.id)).toEqual(ids);
  expect((await saved(page)).connections.map((e) => e.id)).toEqual(
    complete.connections.map((e) => e.id),
  );
  await page.screenshot({ path: "/tmp/vizli-aws-architecture-flow.png" });
  await page.reload();
  const reloaded = await saved(page);
  expect(reloaded.id).toBe(complete.id);
  expect(reloaded.objects.map((o) => o.id)).toEqual(ids);
  expect(reloaded.connections.map((e) => e.id)).toEqual(
    complete.connections.map((e) => e.id),
  );
});

test("explicit cancel and unrelated cue replacement release the architecture queue", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const websocketFrames: string[] = [];
  const browserErrors: string[] = [];
  const diagnosticsPath = test.info().outputPath("aws-cancellation-events.ndjson");
  await writeFile(diagnosticsPath, "");
  cancellationDiagnostics = {
    phase: "opening whiteboard",
    websocketFrames,
    browserErrors,
    path: diagnosticsPath,
  };
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => {
      const value = `sent ${String(event.payload)}`;
      websocketFrames.push(value);
      void appendFile(diagnosticsPath, `${JSON.stringify({ at: Date.now(), phase: cancellationDiagnostics?.phase, value })}\n`);
    });
    socket.on("framereceived", (event) => {
      const value = `received ${String(event.payload)}`;
      websocketFrames.push(value);
      void appendFile(diagnosticsPath, `${JSON.stringify({ at: Date.now(), phase: cancellationDiagnostics?.phase, value })}\n`);
    });
  });
  page.on("pageerror", (error) => {
    browserErrors.push(error.message);
    void appendFile(diagnosticsPath, `${JSON.stringify({ at: Date.now(), phase: cancellationDiagnostics?.phase, error: error.message })}\n`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserErrors.push(message.text());
      void appendFile(diagnosticsPath, `${JSON.stringify({ at: Date.now(), phase: cancellationDiagnostics?.phase, error: message.text() })}\n`);
    }
  });
  await openArchitectureBoard(page);
  const playback = page.getByTestId("presentation-playback");

  cancellationDiagnostics.phase = "initial clause then explicit cancel";
  await cue(page, meetingClauses[0]!);
  await expect(playback).toHaveAttribute("data-state", "playing");
  await page.getByTestId("playback-cancel").click();
  await expect(playback).toHaveAttribute("data-state", "cancelled");

  // A new AWS clause must still dispatch after the explicit cancellation.
  cancellationDiagnostics.phase = "route53 clause after explicit cancel";
  await cue(page, meetingClauses[1]!);
  await expect(playback).toHaveAttribute("data-state", "playing");
  await expect
    .poll(async () => (await saved(page)).objects.some((o) => o.aws?.service === "route53"))
    .toBe(true);

  // A plain cue is a real replacement: it cancels the active animation and the
  // server must continue accepting a later AWS clause after that cancellation.
  cancellationDiagnostics.phase = "unrelated cue replacement";
  await cue(page, "Highlight Meeting agenda");
  await expect(playback).toHaveAttribute("data-state", "cancelled");
  await expect
    .poll(async () => page.locator('[data-testid="visual-effect"]').count())
    .toBeGreaterThan(0);
  cancellationDiagnostics.phase = "alb clause after unrelated cue";
  await cue(page, meetingClauses[2]!);
  await expect(playback).toHaveAttribute("data-state", "playing");
  await expect
    .poll(async () => (await saved(page)).objects.some((o) => o.aws?.service === "alb"))
    .toBe(true);

  const alb = (await saved(page)).objects.find((o) => o.aws?.service === "alb")!;
  cancellationDiagnostics.phase = "manual inspector edit cancels active playback";
  await page.locator(`[data-object-id="${alb.id}"]`).click();
  await page.getByTestId("inspector-label").fill("Edited regional load balancer");
  await expect(playback).toHaveAttribute("data-state", "cancelled");

  // A persistent edit also cancels genuinely, then the session accepts a new stage.
  cancellationDiagnostics.phase = "ec2 clause after manual edit";
  await cue(page, meetingClauses[3]!);
  await expect(playback).toHaveAttribute("data-state", "playing");
  await expect
    .poll(async () => (await saved(page)).objects.some((o) => o.aws?.service === "ec2"))
    .toBe(true);

  // Switching scenes during a running sequence cancels the old action rather
  // than reporting it complete, and returning to the board remains usable.
  cancellationDiagnostics.phase = "switching away from active ec2 sequence";
  await expect(playback).toHaveAttribute("data-state", "playing");
  await page.getByTestId("scenes-toggle").click();
  await page.getByTestId("scene-button-meeting-brief").click();
  await expect(playback).toHaveAttribute("data-state", "cancelled");
  await page.getByTestId("scenes-toggle").click();
  await page.getByTestId("scene-button-aws-meeting-board").click();
  cancellationDiagnostics.phase = "postgres clause after scene switch and return";
  await cue(page, meetingClauses[4]!);
  await expect(playback).toHaveAttribute("data-state", "playing");
  await expect
    .poll(async () => (await saved(page)).objects.some((o) => o.label === "Read replicas · multiple"))
    .toBe(true);
  try {
    await expect(playback).toHaveAttribute("data-state", "completed");
  } catch (error) {
    const ui = await page.evaluate(() => ({
      notices: [...document.querySelectorAll('[role="status"], .toast')].map((el) => el.textContent),
      cueText: document.querySelector(".cue-form")?.textContent,
      playbackState: document.querySelector('[data-testid="presentation-playback"]')?.getAttribute("data-state"),
      sceneId: document.querySelector("[data-scene-id]")?.getAttribute("data-scene-id"),
      sceneRevision: document.querySelector("[data-scene-id]")?.getAttribute("data-revision"),
      project: localStorage.getItem("vizli.project.v1"),
    })).catch(() => ({ notices: [], cueText: "page closed", playbackState: "page closed", sceneId: "unknown", sceneRevision: "unknown", project: "unavailable" }));
    await page.screenshot({ path: test.info().outputPath("aws-cancelled-after-reentry.png") }).catch(() => {});
    await test.info().attach("aws-cancellation-debug.json", {
      body: Buffer.from(
        JSON.stringify(
          {
            websocketFrames,
            browserErrors,
            phase: cancellationDiagnostics?.phase,
            ui,
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
    throw error;
  }
});

test("the compact AWS flow remains legible inside a finite architecture slide", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const websocketFrames: string[] = [];
  const browserErrors: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) =>
      websocketFrames.push(`sent ${String(event.payload)}`),
    );
    socket.on("framereceived", (event) =>
      websocketFrames.push(`received ${String(event.payload)}`),
    );
  });
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  await openArchitectureSlide(page);
  const playback = page.getByTestId("presentation-playback");
  for (const phrase of meetingClauses) await cue(page, phrase);
  await expect
    .poll(async () => (await saved(page)).objects.filter((o) => o.plugin?.id === "cloud.aws").length)
    .toBe(6);
  try {
    await expect(playback).toHaveAttribute("data-state", "completed", {
      timeout: 15_000,
    });
  } catch (error) {
    await test.info().attach("aws-slide-debug.json", {
      body: Buffer.from(
        JSON.stringify({ websocketFrames, browserErrors }, null, 2),
      ),
      contentType: "application/json",
    });
    throw error;
  }

  const scene = await saved(page);
  const viewport = page.locator('[data-testid="scene-canvas"]');
  const box = await viewport.boundingBox();
  expect(box).toBeTruthy();
  for (const object of scene.objects.filter((o) => o.plugin?.id === "cloud.aws")) {
    expect(object.x).toBeGreaterThanOrEqual(0);
    expect(object.y).toBeGreaterThanOrEqual(0);
    expect(object.x + object.width).toBeLessThanOrEqual(1200);
    expect(object.y + object.height).toBeLessThanOrEqual(675);
    await expect(page.locator(`[data-object-id="${object.id}"]`)).toBeVisible();
  }
  await expect(page.getByText(/DNS is best effort; nearest region is not guaranteed/)).toBeVisible();
  await page.screenshot({ path: "/tmp/vizli-aws-architecture-slide.png" });
});
