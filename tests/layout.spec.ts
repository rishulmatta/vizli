import {test,expect} from '@playwright/test';
import {createDemoProject} from '../packages/shared/src/index';
import {newWhiteboard} from './ui';
for(const viewport of [{width:1440,height:960},{width:390,height:844}]) {
 test(`canvas fills viewport and floating controls stay accessible at ${viewport.width}px`,async({page})=>{
  await page.setViewportSize(viewport);
  const project=createDemoProject();project.id=`e2e-layout-${crypto.randomUUID()}`;
  await page.addInitScript(p=>localStorage.setItem('vizli.project.v1',JSON.stringify(p)),project);
  await page.goto('/');
  const canvas=page.getByTestId('scene-canvas');
  await expect(canvas).toBeVisible();
  const before=await canvas.boundingBox();expect(before).toBeTruthy();
  expect(before!.x).toBeLessThanOrEqual(1);expect(before!.y).toBeLessThanOrEqual(1);
  expect(before!.width).toBeGreaterThanOrEqual(viewport.width-1);expect(before!.height).toBeGreaterThanOrEqual(viewport.height-1);
  await expect(page.getByRole('navigation',{name:'Presentation scenes'})).toHaveCount(0);
  await expect(page.getByTestId('project-export')).toBeHidden();
  await expect(page.locator('.assistant-panel')).toHaveCount(0);
  for(const id of ['scenes-toggle','project-menu-toggle','microphone-toggle','cue-input','cue-submit','mode-editing','mode-presenting'])await expect(page.getByTestId(id)).toBeVisible();
  await page.getByTestId('scenes-toggle').click();await expect(page.getByTestId('scene-button-marketing')).toBeVisible();
  expect(await canvas.boundingBox()).toEqual(before);
  await page.keyboard.press('Escape');await expect(page.getByRole('navigation',{name:'Presentation scenes'})).toHaveCount(0);
  await page.getByTestId('project-menu-toggle').click();await expect(page.getByTestId('project-export')).toBeVisible();
  await page.keyboard.press('Escape');await expect(page.getByTestId('project-export')).toBeHidden();
  await newWhiteboard(page);await expect(canvas).toHaveAttribute('data-layout','whiteboard');
  const box=(await canvas.boundingBox())!;expect(box.width).toBeGreaterThanOrEqual(viewport.width-1);expect(box.height).toBeGreaterThanOrEqual(viewport.height-1);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
 });
}
