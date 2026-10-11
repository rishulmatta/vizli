import { test, expect, type Locator, type Page } from '@playwright/test';
import { createDemoProject, type Scene } from '../packages/shared/src/index';
import { newWhiteboard } from './ui';

type Point = [number, number];
type SavedStroke = { id: string; color: string; width: number; points: number[] };
type Stage = { box: { x: number; y: number; width: number; height: number }; scale: number };

test.beforeEach(async ({ page }) => {
  const project = createDemoProject();
  project.id = `e2e-ink-${crypto.randomUUID()}`;
  // Guarded so a reload keeps the strokes the test has already saved.
  await page.addInitScript(
    (p) => {
      if (!localStorage.getItem('vizli.project.v1')) localStorage.setItem('vizli.project.v1', JSON.stringify(p));
    },
    project,
  );
});

async function stage(page: Page): Promise<Stage> {
  const box = (await page.locator('.viz-scene-stage').boundingBox())!;
  return { box, scale: box.width / 1200 };
}

/** Logical (1200 x 675) scene point to client coordinates for the current stage box. */
function toClient(s: Stage, [x, y]: Point) {
  return { x: Math.round(s.box.x + x * s.scale), y: Math.round(s.box.y + y * s.scale) };
}

async function drawMouse(page: Page, s: Stage, points: Point[]) {
  const [first, ...rest] = points.map((p) => toClient(s, p));
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (const p of rest) await page.mouse.move(p.x, p.y, { steps: 8 });
  await page.mouse.up();
}

/** Saved ink strokes of the first scene (slide by default) that has any. */
async function savedInk(page: Page, layout: 'slide' | 'whiteboard' = 'slide'): Promise<SavedStroke[]> {
  return page.evaluate((wanted) => {
    const project = JSON.parse(localStorage.getItem('vizli.project.v1')!);
    const scene = project.scenes.find((s: Scene) => (s.layout ?? 'slide') === wanted && s.ink?.length);
    return scene?.ink ?? [];
  }, layout);
}

test('pen strokes commit, persist, pick colors and undo', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const layer = page.getByTestId('ink-layer');
  await page.getByTestId('ink-tool-pen').click();
  await expect(layer).toHaveAttribute('data-ink-active', 'pen');

  const s = await stage(page);
  await page.getByTestId('ink-color-yellow').click();
  const yellow: Point[] = [[200, 300], [320, 260], [440, 330], [560, 280]];
  await drawMouse(page, s, yellow);
  await expect(page.locator('path[data-ink-id]')).toHaveCount(1);
  await expect(page.locator('path[data-ink-id]')).toHaveAttribute('data-ink-color', '#f2c94c');

  await expect.poll(async () => (await savedInk(page)).length).toBe(1);
  const [stroke] = await savedInk(page);
  expect(stroke.color).toBe('#f2c94c');
  expect(stroke.points.length % 2).toBe(0);
  expect(stroke.points.length).toBeGreaterThanOrEqual(4);
  const xs = yellow.map((p) => p[0]);
  const ys = yellow.map((p) => p[1]);
  for (let i = 0; i < stroke.points.length; i += 2) {
    expect(stroke.points[i]).toBeGreaterThanOrEqual(Math.min(...xs) - 3);
    expect(stroke.points[i]).toBeLessThanOrEqual(Math.max(...xs) + 3);
    expect(stroke.points[i + 1]).toBeGreaterThanOrEqual(Math.min(...ys) - 3);
    expect(stroke.points[i + 1]).toBeLessThanOrEqual(Math.max(...ys) + 3);
  }

  await page.getByTestId('ink-color-red').click();
  await drawMouse(page, s, [[620, 460], [760, 500], [900, 450], [1000, 500]]);
  await expect(page.locator('path[data-ink-id]')).toHaveCount(2);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'docs/screenshots/ink.png', fullPage: true });

  await page.getByTestId('undo-button').click();
  await expect(page.locator('path[data-ink-id]')).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('ink-layer')).toBeVisible();
  await expect(page.locator('path[data-ink-id]')).toHaveCount(1);
  await expect(page.locator('path[data-ink-id]')).toHaveAttribute('data-ink-color', '#f2c94c');
});

test('pen pointer events draw and the eraser removes crossed strokes in one undoable step', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const layer = page.getByTestId('ink-layer');
  await page.getByTestId('ink-tool-pen').click();
  await expect(layer).toHaveAttribute('data-ink-active', 'pen');

  const s = await stage(page);
  const pen = { pointerType: 'pen', pointerId: 7, isPrimary: true, button: 0, bubbles: true, pressure: 0.5 };
  const penPath: Point[] = [[150, 250], [300, 300], [450, 250]];
  const first = toClient(s, penPath[0]);
  await layer.dispatchEvent('pointerdown', { ...pen, buttons: 1, clientX: first.x, clientY: first.y });
  for (const p of penPath.slice(1)) {
    const c = toClient(s, p);
    await layer.dispatchEvent('pointermove', { ...pen, buttons: 1, clientX: c.x, clientY: c.y });
  }
  const last = toClient(s, penPath[penPath.length - 1]);
  await layer.dispatchEvent('pointerup', { ...pen, buttons: 0, clientX: last.x, clientY: last.y });
  await expect(page.locator('path[data-ink-id]')).toHaveCount(1);

  await drawMouse(page, s, [[620, 460], [760, 500], [900, 450], [1000, 500]]);
  await expect(page.locator('path[data-ink-id]')).toHaveCount(2);
  const [kept] = (await savedInk(page)).filter((stroke) => stroke.points[0] > 600);
  expect(kept).toBeDefined();

  // Eraser sweep crosses only the first (pen) stroke at y ~ 275.
  await page.getByTestId('ink-tool-eraser').click();
  await expect(layer).toHaveAttribute('data-ink-active', 'eraser');
  const from = toClient(s, [120, 275]);
  const to = toClient(s, [480, 275]);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('path[data-ink-id]')).toHaveCount(1);
  await expect.poll(async () => (await savedInk(page)).length).toBe(1);
  expect((await savedInk(page))[0].id).toBe(kept!.id);

  // One gesture is one undo step: both strokes come back together.
  await page.getByTestId('undo-button').click();
  await expect(page.locator('path[data-ink-id]')).toHaveCount(2);
});

test('ink stays available while presenting and clear removes everything', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await page.getByTestId('ink-tool-pen').click();
  await drawMouse(page, await stage(page), [[200, 300], [400, 320]]);
  await expect(page.locator('path[data-ink-id]')).toHaveCount(1);

  await page.getByTestId('mode-presenting').click();
  const pen = page.getByTestId('ink-tool-pen');
  await expect(pen).toBeVisible();
  if ((await pen.getAttribute('aria-pressed')) !== 'true') await pen.click();
  await expect(pen).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('ink-layer')).toHaveAttribute('data-ink-active', 'pen');

  await drawMouse(page, await stage(page), [[600, 300], [800, 340]]);
  await expect(page.locator('path[data-ink-id]')).toHaveCount(2);

  await page.getByTestId('ink-clear').click();
  await expect(page.locator('path[data-ink-id]')).toHaveCount(0);
  await expect(page.getByTestId('ink-clear')).toBeDisabled();

  await page.getByTestId('undo-button').click();
  await expect(page.locator('path[data-ink-id]')).toHaveCount(2);
});

test('whiteboard strokes live in world space and follow the camera', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await newWhiteboard(page);
  await page.getByTestId('ink-tool-pen').click();

  const s = await stage(page);
  await drawMouse(page, s, [[400, 300], [600, 340], [700, 380]]);
  const path = page.locator('path[data-ink-id]').first();
  await expect(path).toBeVisible();
  await expect.poll(async () => (await savedInk(page, 'whiteboard')).length).toBe(1);
  const [saved] = await savedInk(page, 'whiteboard');
  const before = (await path.boundingBox())!;

  await page.getByTestId('board-pan-right').click();
  await expect.poll(async () => (await path.boundingBox())!.x).toBeLessThan(before.x - 1);
  const after = (await path.boundingBox())!;
  expect(before.x - after.x).toBeGreaterThan(0);
  expect((await savedInk(page, 'whiteboard'))[0].points).toEqual(saved.points);

  await page.keyboard.press('Escape');
  await expect.poll(() => page.getByTestId('ink-layer').evaluate((el) => el.hasAttribute('data-ink-active'))).toBe(false);
});
