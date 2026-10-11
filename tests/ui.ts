import { type Page, expect } from '@playwright/test';
export async function openScenes(page: Page) {
  const toggle=page.getByTestId('scenes-toggle');
  if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
}
export async function selectScene(page: Page,id:string) {
  await openScenes(page);await page.getByTestId(`scene-button-${id}`).click();
  if(await page.getByTestId('scenes-toggle').getAttribute('aria-expanded')==='true')await page.getByRole('button',{name:'Close scenes',exact:true}).click();
}
export async function openProjectMenu(page:Page) {
  const toggle=page.getByTestId('project-menu-toggle');
  if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
}
export async function closeProjectMenu(page:Page) {
  const toggle=page.getByTestId('project-menu-toggle');
  if(await toggle.getAttribute('aria-expanded')==='true')await toggle.click();
}
export async function newWhiteboard(page:Page) {
  await openScenes(page);await page.getByTestId('new-whiteboard').click();
  if(await page.getByTestId('scenes-toggle').getAttribute('aria-expanded')==='true')await page.getByRole('button',{name:'Close scenes',exact:true}).click();
  await expect(page.getByTestId('scene-canvas')).toHaveAttribute('data-layout','whiteboard');
}
