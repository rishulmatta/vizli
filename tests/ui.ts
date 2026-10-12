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

/** Per-user camera for a scene from `vizli.view.<projectId>` (falls back to the scene's initial viewport). Writes are debounced 200 ms, so poll. */
export async function savedViewport(page:Page,sceneId:string) {
  return page.evaluate((id)=>{
    const project=JSON.parse(localStorage.getItem("vizli.project.v1")!);
    const views=JSON.parse(localStorage.getItem(`vizli.view.${project.id}`)??"{}");
    const scene=project.scenes.find((s:{id:string})=>s.id===id);
    return (views[id]?.viewport??scene?.viewport??{x:0,y:0,zoom:1}) as {x:number;y:number;zoom:number};
  },sceneId);
}

/** The open project's plain mirror (`vizli.project.v1`, written 300 ms after document changes). Pass `id` to assert it is that project. */
export async function readProject(page:Page,id?:string) {
  const project=await page.evaluate(()=>JSON.parse(localStorage.getItem("vizli.project.v1")??"null"));
  if(id!==undefined)expect(project?.id).toBe(id);
  return project as import("../packages/shared/src/index").Project;
}

type SessionMessage = { type: string; [key: string]: any };
/**
 * Proxies `/api/session` to the real server (join, Yjs sync and awareness pass through) while letting a
 * test answer selected client messages itself. Return `true` from `intercept` to swallow the message.
 * `session.sceneId` follows the client's `join`/`view` messages.
 */
export async function proxySession(page:Page,intercept:(message:SessionMessage,session:{sceneId:string;reply:(message:unknown)=>void})=>boolean|void) {
  await page.routeWebSocket('**/api/session',(socket)=>{
    const server=socket.connectToServer();
    const session={sceneId:'',reply:(message:unknown)=>socket.send(JSON.stringify(message))};
    socket.onMessage((raw)=>{
      if(typeof raw==='string'){
        let message:SessionMessage|undefined;
        try{message=JSON.parse(raw);}catch{/* forward as is */}
        if(message){
          if((message.type==='join'||message.type==='view')&&message.sceneId)session.sceneId=message.sceneId;
          if(intercept(message,session)===true)return;
        }
      }
      server.send(raw);
    });
  });
}
