import { test, expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { createDemoProject } from '../packages/shared/src/index';
import { newWhiteboard, readProject, selectScene } from './ui';

/**
 * Two browser contexts (separate storage, separate identities) on one project link through the isolated
 * demo server. Context A seeds the project through `join.seed`; context B joins the existing room.
 */
type Peer = { context: BrowserContext; page: Page };
const SYNC = { timeout: 10_000 };

async function openPeer(browser: Browser, projectId: string, seed?: ReturnType<typeof createDemoProject>): Promise<Peer> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  if (seed)
    await context.addInitScript((p) => {
      if (!localStorage.getItem('vizli.project.v1')) localStorage.setItem('vizli.project.v1', JSON.stringify(p));
    }, seed);
  await page.goto(`/p/${projectId}`);
  await expect(page.getByTestId('scene-canvas')).toBeVisible(SYNC);
  await expect(page.locator('[data-object-id="revenue"]')).toBeVisible(SYNC);
  return { context, page };
}

async function dragBy(page: Page, target: Locator, dx: number, dy: number) {
  const box = (await target.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + 14 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + dx / 2, start.y + dy / 2, { steps: 4 });
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 4 });
  await page.mouse.up();
}

async function drawStroke(page: Page, from: [number, number], to: [number, number]) {
  const box = (await page.locator('.viz-scene-stage').boundingBox())!;
  const scale = box.width / 1200;
  const at = ([x, y]: [number, number]) => ({ x: Math.round(box.x + x * scale), y: Math.round(box.y + y * scale) });
  const a = at(from), b = at(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2 + 30, { steps: 6 });
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
}

const objectX = (page: Page, id: string) => page.evaluate((objectId) => {
  const project = JSON.parse(localStorage.getItem('vizli.project.v1')!);
  for (const scene of project.scenes) {
    const object = scene.objects.find((o: { id: string }) => o.id === objectId);
    if (object) return object.x as number;
  }
  return null;
}, id);

test.describe('collaboration', () => {
  let projectId: string;
  let a: Peer;
  let b: Peer;
  test.beforeEach(async ({ browser }) => {
    projectId = `e2e-collab-${crypto.randomUUID()}`;
    const seed = createDemoProject();
    seed.id = projectId;
    a = await openPeer(browser, projectId, seed);
    b = await openPeer(browser, projectId);
  });
  test.afterEach(async () => {
    await a.context.close();
    await b.context.close();
  });

  test('moves, ink and per-user undo converge across two browsers', async () => {
    const revenueA = a.page.locator('[data-object-id="revenue"]');
    const revenueB = b.page.locator('[data-object-id="revenue"]');
    const beforeA = (await revenueA.boundingBox())!;
    const beforeB = (await revenueB.boundingBox())!;
    const originalX = await objectX(a.page, 'revenue');

    await dragBy(a.page, revenueA, 60, 24);
    await expect.poll(async () => (await revenueA.boundingBox())!.x - beforeA.x, SYNC).toBeGreaterThan(40);
    await expect.poll(async () => (await revenueB.boundingBox())!.x - beforeB.x, SYNC).toBeGreaterThan(40);
    await expect.poll(() => objectX(b.page, 'revenue'), SYNC).toBeGreaterThan(originalX! + 30);

    await b.page.getByTestId('ink-tool-pen').click();
    await drawStroke(b.page, [200, 560], [520, 600]);
    await expect(b.page.locator('path[data-ink-id]')).toHaveCount(1, SYNC);
    await expect(a.page.locator('path[data-ink-id]')).toHaveCount(1, SYNC);
    await b.page.getByTestId('ink-tool-pen').click();

    // A undoes its own move; B's stroke survives on both screens.
    await a.page.getByTestId('undo-button').click();
    await expect.poll(() => objectX(a.page, 'revenue'), SYNC).toBe(originalX);
    await expect.poll(() => objectX(b.page, 'revenue'), SYNC).toBe(originalX);
    await expect(a.page.locator('path[data-ink-id]')).toHaveCount(1);
    await expect(b.page.locator('path[data-ink-id]')).toHaveCount(1);

    // B undoes its stroke; A has nothing left to undo.
    await b.page.getByTestId('undo-button').click();
    await expect(b.page.locator('path[data-ink-id]')).toHaveCount(0, SYNC);
    await expect(a.page.locator('path[data-ink-id]')).toHaveCount(0, SYNC);
    await expect(a.page.getByTestId('undo-button')).toBeDisabled();
  });

  test('whiteboard cameras stay per user while named areas are shared', async () => {
    await newWhiteboard(a.page);
    const boardId = (await readProject(a.page, projectId)).scenes.find((s) => s.layout === 'whiteboard')!.id;
    await expect.poll(async () => (await readProject(b.page, projectId)).scenes.some((s) => s.id === boardId), SYNC).toBe(true);
    await selectScene(b.page, boardId);
    await expect(b.page.getByTestId('scene-canvas')).toHaveAttribute('data-layout', 'whiteboard');

    await a.page.getByTestId('board-pan-right').click();
    await expect.poll(() => a.page.getByTestId('scene-canvas').getAttribute('data-camera-x'), SYNC).not.toBe('0');
    await a.page.getByTestId('board-area-name').fill('Second idea');
    await a.page.getByTestId('board-area-rename').click();
    await expect(b.page.getByTestId('board-area-select').locator('option', { hasText: 'Second idea' })).toHaveCount(1, SYNC);
    // B never moved: its camera is still at the origin even though A's camera and the shared areas changed.
    await expect(b.page.getByTestId('scene-canvas')).toHaveAttribute('data-camera-x', '0');
    expect(Number(await a.page.getByTestId('scene-canvas').getAttribute('data-camera-x'))).toBeGreaterThan(0);
  });

  test('edits made while a peer is offline reconcile on reconnect', async () => {
    const revenueA = a.page.locator('[data-object-id="revenue"]');
    const originalX = await objectX(a.page, 'revenue');
    await b.context.setOffline(true);
    await dragBy(a.page, revenueA, 60, 0);
    await expect.poll(() => objectX(a.page, 'revenue'), SYNC).toBeGreaterThan(originalX! + 30);
    await b.page.getByTestId('ink-tool-pen').click();
    await drawStroke(b.page, [200, 560], [520, 600]);
    await expect(b.page.locator('path[data-ink-id]')).toHaveCount(1);
    await b.page.getByTestId('ink-tool-pen').click();
    expect(await objectX(b.page, 'revenue')).toBe(originalX);
    await expect(a.page.locator('path[data-ink-id]')).toHaveCount(0);

    await b.context.setOffline(false);
    await expect.poll(() => objectX(b.page, 'revenue'), { timeout: 20_000 }).toBeGreaterThan(originalX! + 30);
    await expect(a.page.locator('path[data-ink-id]')).toHaveCount(1, { timeout: 20_000 });
    const [projectA, projectB] = await Promise.all([readProject(a.page, projectId), readProject(b.page, projectId)]);
    expect(projectB.scenes[0].objects.find((o) => o.id === 'revenue')?.x).toBe(projectA.scenes[0].objects.find((o) => o.id === 'revenue')?.x);
    expect(projectA.scenes[0].ink?.length ?? 0).toBe(1);
  });
  test('peer cursors and selections are visible while editing and only presenters show in Present mode', async () => {
    await expect(a.page.getByTestId('presence-status')).toHaveText('Live', SYNC);
    await expect(b.page.getByTestId('presence-status')).toHaveText('Live', SYNC);
    const stage = (await b.page.locator('.viz-scene-stage').boundingBox())!;
    await b.page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height * 0.8);
    await b.page.mouse.move(stage.x + stage.width / 2 + 20, stage.y + stage.height * 0.8 + 10);
    const nameB = (await b.page.getByTestId('local-avatar').getAttribute('title'))!.replace(/ \(you\).*$/, '');
    await expect(a.page.locator('[data-peer-cursor]')).toHaveCount(1, SYNC);
    await expect(a.page.locator('[data-peer-cursor]')).toContainText(nameB);

    await b.page.locator('[data-object-id="revenue"]').click();
    await expect(a.page.locator('[data-peer-selection]')).toHaveCount(1, SYNC);
    await a.page.evaluate(() => document.fonts.ready);
    await a.page.screenshot({ path: 'docs/screenshots/collab.png', fullPage: true });

    // B presents: B no longer renders A's cursor while A is only editing.
    await a.page.mouse.move(stage.x + 200, stage.y + 300);
    await a.page.mouse.move(stage.x + 220, stage.y + 310);
    await expect(b.page.locator('[data-peer-cursor]')).toHaveCount(1, SYNC);
    await b.page.getByTestId('mode-presenting').click();
    await expect(b.page.locator('[data-peer-cursor]')).toHaveCount(0, SYNC);
    await expect(a.page.locator('[data-peer-selection]')).toHaveCount(0, SYNC);
    await b.page.mouse.move(stage.x + 400, stage.y + 300);
    await b.page.mouse.move(stage.x + 420, stage.y + 320);
    await expect(a.page.locator('[data-peer-cursor]')).toHaveCount(1, SYNC);

    // A presents: B (editing again) still sees A's cursor.
    await b.page.getByTestId('mode-editing').click();
    await a.page.getByTestId('mode-presenting').click();
    await a.page.mouse.move(stage.x + 300, stage.y + 320);
    await a.page.mouse.move(stage.x + 320, stage.y + 330);
    await expect(b.page.locator('[data-peer-cursor]')).toHaveCount(1, SYNC);
  });

  test('share link copies the project URL and the roster counts peers', async () => {
    await a.context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await expect(a.page.getByTestId('peer-avatar')).toHaveCount(1, SYNC);
    await a.page.getByTestId('share-link').click();
    const text = await a.page.evaluate(() => navigator.clipboard.readText());
    expect(text.endsWith(`/p/${projectId}`)).toBe(true);
    await b.context.close();
    await expect(a.page.getByTestId('peer-avatar')).toHaveCount(0, { timeout: 20_000 });
  });

  test('follow presenter mirrors the presenter\'s whiteboard camera', async () => {
    await newWhiteboard(a.page);
    const boardId = (await readProject(a.page, projectId)).scenes.find((s) => s.layout === 'whiteboard')!.id;
    await expect.poll(async () => (await readProject(b.page, projectId)).scenes.some((s) => s.id === boardId), SYNC).toBe(true);
    await selectScene(b.page, boardId);
    await a.page.getByTestId('mode-presenting').click();
    await expect(b.page.getByTestId('follow-presenter')).toBeVisible(SYNC);
    await b.page.getByTestId('follow-presenter').click();
    await a.page.getByTestId('board-pan-right').click();
    await expect.poll(() => a.page.getByTestId('scene-canvas').getAttribute('data-camera-x'), SYNC).not.toBe('0');
    // Both cameras ease; compare live values until they settle on the same number (and A has really moved).
    await expect.poll(async () => {
      const [x, y] = await Promise.all([a.page, b.page].map((p) => p.getByTestId('scene-canvas').getAttribute('data-camera-x')));
      return Number(x) > 0 && x === y;
    }, SYNC).toBe(true);
  });
});
