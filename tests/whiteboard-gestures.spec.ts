import { test, expect, type Page } from '@playwright/test';
import { createDemoProject, type Scene, type BoardViewport } from '../packages/shared/src/index';

const sceneId = 'gesture-board';
async function savedBoard(page: Page): Promise<Scene> {
  return page.evaluate(id => JSON.parse(localStorage.getItem('vizli.project.v1')!).scenes.find((scene: Scene) => scene.id === id), sceneId);
}
async function camera(page: Page): Promise<BoardViewport> {
  const canvas = page.getByTestId('scene-canvas');
  return {
    x: Number(await canvas.getAttribute('data-camera-x')),
    y: Number(await canvas.getAttribute('data-camera-y')),
    zoom: Number(await canvas.getAttribute('data-camera-zoom')),
  };
}

test.beforeEach(async ({ page }) => {
  const project = createDemoProject();
  project.id = `e2e-board-gestures-${crypto.randomUUID()}`;
  project.title = 'A system worth showing';
  project.scenes.unshift({
    id: sceneId, title: 'The architecture whiteboard', subtitle: '', kind: 'architecture', layout: 'whiteboard',
    viewport: { x: -40, y: -25, zoom: .88 },
    activeAreaId: 'request-flow',
    areas: [
      { id: 'request-flow', label: '01 / Request lifecycle', x: 0, y: 0, width: 1200, height: 675 },
      { id: 'next-idea', label: '02 / Room for the next idea', x: 1320, y: 0, width: 1200, height: 675 },
    ],
    objects: [
      { id: 'board-heading', kind: 'text', label: 'A little clarity goes a long way.', text: 'Follow a request from the first click to the last response.', x: 65, y: 65, width: 1000, height: 100 },
      { id: 'web-client', kind: 'node', label: 'Web client', text: 'Capture an idea', x: 70, y: 245, width: 245, height: 130 },
      { id: 'api-service', kind: 'node', label: 'Application API', text: 'Understand · validate · act', x: 470, y: 245, width: 245, height: 130 },
      { id: 'database', kind: 'node', label: 'Project memory', text: 'Keep every object editable', x: 870, y: 245, width: 245, height: 130 },
      { id: 'board-note', kind: 'text', label: 'A canvas that grows with the conversation.', text: 'Pan to the next area. Keep this explanation exactly where you left it.', x: 70, y: 475, width: 1040, height: 120 },
      { id: 'far-object', kind: 'node', label: 'A distant idea', x: 800000, y: -800000, width: 240, height: 120 },
    ],
    connections: [
      { id: 'request', source: 'web-client', target: 'api-service', label: 'A spoken cue' },
      { id: 'save', source: 'api-service', target: 'database', label: 'A visual action' },
    ],
  });
  await page.addInitScript(project => {
    if (!localStorage.getItem('vizli.project.v1')) localStorage.setItem('vizli.project.v1', JSON.stringify(project));
  }, project);
});

test('whiteboard wheel, pointer-centered zoom and drag persist camera without editing objects', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1050 });
  await page.goto('/');
  const canvas = page.getByTestId('scene-canvas');
  await expect(canvas).toHaveAttribute('data-layout', 'whiteboard');
  await expect(page.locator('[data-object-id="web-client"]')).toBeVisible();
  await expect(page.locator('[data-object-id="far-object"]')).toHaveCount(0);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'docs/screenshots/whiteboard.png', fullPage: true });
  const originalObjects = (await savedBoard(page)).objects;
  const stage = page.locator('.viz-scene-stage');
  const bounds = (await stage.boundingBox())!;
  const scale = bounds.width / 1200;
  const pointer = { x: Math.round(bounds.x + bounds.width * .64), y: Math.round(bounds.y + bounds.height * .72) };
  await page.mouse.move(pointer.x, pointer.y);

  const beforeWheel = await camera(page);
  await page.mouse.wheel(70, 90);
  await expect(canvas).toHaveAttribute('data-navigation-state', 'idle');
  await expect.poll(async () => (await savedBoard(page)).viewport?.x).toBeCloseTo(beforeWheel.x + 70 / (scale * beforeWheel.zoom), 2);
  expect((await camera(page)).y).toBeCloseTo(beforeWheel.y + 90 / (scale * beforeWheel.zoom), 2);

  const beforeZoom = await camera(page);
  const point = { x: (pointer.x - bounds.x) / scale, y: (pointer.y - bounds.y) / scale };
  const worldPoint = { x: beforeZoom.x + point.x / beforeZoom.zoom, y: beforeZoom.y + point.y / beforeZoom.zoom };
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -130);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(beforeZoom.zoom);
  await expect(canvas).toHaveAttribute('data-navigation-state', 'idle');
  const afterZoom = await camera(page);
  expect(afterZoom.x + point.x / afterZoom.zoom).toBeCloseTo(worldPoint.x, 2);
  expect(afterZoom.y + point.y / afterZoom.zoom).toBeCloseTo(worldPoint.y, 2);

  // Space+drag over an actual object must navigate, not accidentally move it.
  const object = page.locator('[data-object-id="api-service"]');
  const objectBounds = (await object.boundingBox())!;
  const start = { x: objectBounds.x + objectBounds.width / 2, y: objectBounds.y + objectBounds.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await expect(canvas).toHaveAttribute('data-navigation-state', 'panning');
  await page.mouse.move(start.x + 45, start.y + 30, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  await expect(canvas).toHaveAttribute('data-navigation-state', 'idle');
  await expect.poll(async () => (await savedBoard(page)).viewport?.x).toBeCloseTo(afterZoom.x - 45 / (scale * afterZoom.zoom), 2);
  const saved = await savedBoard(page);
  expect(saved.viewport!.y).toBeCloseTo(afterZoom.y - 30 / (scale * afterZoom.zoom), 2);
  expect(saved.objects).toEqual(originalObjects);

  // A plain drag on blank canvas also pans; then reload the same saved camera.
  const beforeDrag = await camera(page);
  const blank = { x: bounds.x + bounds.width - 35, y: bounds.y + bounds.height - 60 };
  await page.mouse.move(blank.x, blank.y);
  await page.mouse.down();
  await page.mouse.move(blank.x - 30, blank.y - 20, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await savedBoard(page)).viewport?.x).toBeCloseTo(beforeDrag.x + 30 / (scale * beforeDrag.zoom), 2);
  const persisted = (await savedBoard(page)).viewport;
  await page.reload();
  await expect(canvas).toHaveAttribute('data-layout', 'whiteboard');
  expect(await camera(page)).toEqual(persisted);
  expect((await savedBoard(page)).objects).toEqual(originalObjects);
});
