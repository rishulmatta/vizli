import { test, expect } from "@playwright/test";
import {
  createDemoProject,
  createPluginObject,
} from "../packages/shared/src/index";
import { proxySession } from "./ui";

test("domain parts share exact voice targets; draw playback completes and cancels without changing the document", async ({
  page,
}) => {
  const project = createDemoProject();
  project.id = `e2e-plugins-${crypto.randomUUID()}`;
  project.scenes = [
    {
      id: "plugins",
      title: "Domain library",
      subtitle: "",
      kind: "slide",
      layout: "whiteboard",
      connections: [],
      objects: [
        createPluginObject("math.matrix", "matrix-c", 40, 170),
        createPluginObject("cloud.aws", "aws-lambda", 410, 170),
        createPluginObject("uml.class", "customer", 790, 170),
      ],
    },
  ];
  project.cues = [];
  await page.addInitScript((p) => {
    if (!localStorage.getItem("vizli.project.v1"))
      localStorage.setItem("vizli.project.v1", JSON.stringify(p));
  }, project);
  const acknowledgements: { type: string; actionId: string }[] = [];
  let count = 0;
  await proxySession(page, (m, session) => {
      if (m.type === "applied" || m.type === "animation.completed")
        acknowledgements.push(m);
      if (m.type !== "cue") return;
      const targets: Record<string, string> = {
        method: "customer:method:0",
        attributes: "customer:part:attributes",
        service: "aws-lambda:part:service",
        cell: "matrix-c:cell:0:1",
        column: "matrix-c:col:1",
      };
      const action =
        m.text === "draw"
          ? { type: "animate", targetId: "matrix-c", animation: "draw" }
          : { type: "highlight", targetId: targets[m.text] };
      session.reply({
          type: "action",
          action: {
            id: `plugin-${++count}`,
            sceneId: session.sceneId,
            revision: 0,
            reason: "Plugin acceptance",
            ...action,
          },
        });
      return true;
  });
  await page.goto("/");
  for (const target of [
    "customer:method:0",
    "customer:part:attributes",
    "aws-lambda:part:service",
    "matrix-c:cell:0:1",
  ])
    await expect(page.locator(`[data-target-id="${target}"]`)).toBeVisible();
  const before = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem("vizli.project.v1")!).scenes[0].objects,
  );
  async function cue(text: string) {
    const previous = count;
    await page.getByTestId("cue-input").fill(text);
    await page.getByTestId("cue-submit").click();
    await expect.poll(() => count).toBe(previous + 1);
  }
  for (const [cueText, target] of [
    ["method", "customer:method:0"],
    ["attributes", "customer:part:attributes"],
    ["service", "aws-lambda:part:service"],
    ["cell", "matrix-c:cell:0:1"],
    ["column", "matrix-c:col:1"],
  ]) {
    await cue(cueText);
    await expect(page.getByTestId("visual-effect")).toHaveAttribute(
      "data-target-id",
      target,
    );
  }
  await cue("draw");
  const finishedId = `plugin-${count}`;
  await expect
    .poll(() =>
      acknowledgements.some(
        (a) => a.type === "animation.completed" && a.actionId === finishedId,
      ),
    )
    .toBe(true);
  await cue("draw");
  const cancelledId = `plugin-${count}`;
  await expect
    .poll(() =>
      acknowledgements.some(
        (a) => a.type === "applied" && a.actionId === cancelledId,
      ),
    )
    .toBe(true);
  await cue("method");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await cue("draw");
  const reducedId = `plugin-${count}`;
  await expect
    .poll(() =>
      acknowledgements.some(
        (a) => a.type === "animation.completed" && a.actionId === reducedId,
      ),
    )
    .toBe(true);
  expect(
    acknowledgements.some(
      (a) => a.type === "animation.completed" && a.actionId === cancelledId,
    ),
  ).toBe(false);
  expect(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("vizli.project.v1")!).scenes[0].objects,
    ),
  ).toEqual(before);
  await page.reload();
  await expect(page.locator('[data-target-id="customer:method:0"]')).toHaveText(
    "+ save(): void",
  );
});

test("domain library insertion, internal selection, class editing and motion preference persist", async ({
  page,
}) => {
  const project = createDemoProject();
  project.id = `e2e-library-${crypto.randomUUID()}`;
  project.scenes = [
    {
      id: "library",
      title: "Library",
      subtitle: "",
      kind: "slide",
      layout: "whiteboard",
      objects: [],
      connections: [],
    },
  ];
  project.cues = [];
  await page.addInitScript((p) => {
    if (!localStorage.getItem("vizli.project.v1"))
      localStorage.setItem("vizli.project.v1", JSON.stringify(p));
  }, project);
  await page.goto("/");
  await page.getByRole("button", { name: "Add object", exact: false }).click();
  await page.getByTestId("library-uml").click();
  await page.getByTestId("add-plugin-uml-class").click();
  const objects = () =>
    page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("vizli.project.v1")!).scenes[0].objects,
    );
  await expect.poll(async () => (await objects()).length).toBe(1);
  const id = (await objects())[0].id;
  await page.getByTestId("object-part").selectOption(`${id}:method:0`);
  await page.getByTestId("highlight-part").click();
  await expect(page.getByTestId("visual-effect")).toHaveAttribute(
    "data-target-id",
    `${id}:method:0`,
  );
  await page.getByText("Class attributes & methods", { exact: true }).click();
  await page.getByTestId("uml-methods").fill("+ submit(): boolean");
  await page.getByTestId("apply-uml").click();
  await expect(page.locator(`[data-target-id="${id}:method:0"]`)).toHaveText(
    "+ submit(): boolean",
  );
  await page.getByTestId("motion-preset").selectOption("draw");
  await expect.poll(async () => (await objects())[0].motion).toBe("draw");
  await page.getByTestId("preview-motion").click();
  await page.reload();
  await expect(page.locator(`[data-target-id="${id}:method:0"]`)).toHaveText(
    "+ submit(): boolean",
  );
  expect((await objects())[0].motion).toBe("draw");
});
