import {proxySession, selectScene} from "./ui";
import { test, expect, type Page } from '@playwright/test';
import { createDemoProject, type Scene } from '../packages/shared/src/index';
async function matrix(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('vizli.project.v1')!).scenes.find((s: Scene) => s.id === 'mathematics').objects.find((o: {id:string}) => o.id === 'matrix-a'));
}
test('voice edit actions amend the same matrix atomically, remain targetable, and undo', async ({page}) => {
  const project=createDemoProject();project.id=`e2e-voice-edit-${crypto.randomUUID()}`;
  await page.addInitScript(p=>{if(!localStorage.getItem('vizli.project.v1'))localStorage.setItem('vizli.project.v1',JSON.stringify(p));},project);
  // Exercise the real browser action boundary without spending provider credits.
  let count=0;
  await proxySession(page,(m,session)=>{
      if(m.type!=='cue')return;
      const patches:Record<string,unknown>={resize:{matrix:{rows:3,cols:2}},cell:{cell:{row:2,col:1,value:9}},invalid:{cell:{row:9,col:1,value:8}},shrink:{matrix:{rows:1,cols:2}}};
      const action=m.text==='highlight'?{type:'highlight',targetId:'matrix-a:cell:2:1'}:{type:'edit_object',targetId:'matrix-a',patch:patches[m.text]};
      session.reply({type:'action',action:{id:`edit-${++count}`,sceneId:session.sceneId,revision:0,reason:'Update requested object',...action}});
      return true;
  });
  await page.goto('/');await selectScene(page,"mathematics");
  const original=await matrix(page);
  async function cue(text:string){await page.getByTestId('cue-input').fill(text);await page.getByTestId('cue-submit').click();}
  await cue('resize');await expect.poll(async()=> (await matrix(page)).cells).toEqual([[1,2],[3,4],[0,0]]);
  expect((await matrix(page)).id).toBe(original.id);
  await cue('cell');await expect.poll(async()=> (await matrix(page)).cells).toEqual([[1,2],[3,4],[0,9]]);
  await expect(page.locator('[data-target-id="matrix-a:cell:2:1"]')).toHaveText('9');
  await cue('highlight');await expect(page.getByTestId('visual-effect')).toHaveAttribute('data-target-id','matrix-a:cell:2:1');
  await cue('invalid');await page.getByTestId('activity-toggle').click();await expect(page.getByText('Edit skipped',{exact:true})).toBeVisible();
  expect((await matrix(page)).cells).toEqual([[1,2],[3,4],[0,9]]);
  await page.getByTestId('undo-button').click();await expect.poll(async()=> (await matrix(page)).cells).toEqual([[1,2],[3,4],[0,0]]);
  await page.getByTestId('undo-button').click();await expect.poll(async()=> (await matrix(page)).cells).toEqual(original.cells);
  await page.reload();await selectScene(page,"mathematics");expect((await matrix(page)).cells).toEqual(original.cells);
});
