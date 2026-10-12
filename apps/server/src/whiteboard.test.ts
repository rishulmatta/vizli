import { describe,it,expect,vi } from 'vitest';
import { createDemoProject,SceneSchema,ProjectSchema,getSceneViewport,applyBoardNavigation,appendIllustration,type Scene,type ServerMessage } from '@vizli/shared';
import { localResolve,createNebiusResolver,validateProposal } from './resolver.js';
import { VisualSession } from './session.js';
import { memorySource } from './test-support.js';
const project=createDemoProject();
function board():Scene{return {...structuredClone(project.scenes[2]!),layout:'whiteboard',viewport:{x:0,y:0,zoom:1},areas:[{id:'start',label:'Start',x:0,y:0,width:1200,height:675}],activeAreaId:'start'};}
const actions=(messages:ServerMessage[])=>messages.filter(message=>message.type==='action');
describe('persistent whiteboard scene model',()=>{
 it('keeps old slide JSON valid and accepts bounded world coordinates',()=>{
  expect(ProjectSchema.safeParse(project).success).toBe(true);expect(project.scenes[0]!.layout).toBeUndefined();expect(getSceneViewport(project.scenes[0]!)).toEqual({x:0,y:0,zoom:1});
  const scene=board();scene.objects[0]!.x=25000;scene.objects[0]!.y=-15000;expect(SceneSchema.safeParse(scene).success).toBe(true);scene.objects[0]!.x=1000001;expect(SceneSchema.safeParse(scene).success).toBe(false);
 });
 it('creates neighboring areas and moves only camera, returning to named areas',()=>{
  const scene=board(),right=applyBoardNavigation(scene,{direction:'right'});expect(right.viewport).toEqual({x:1320,y:0,zoom:1});expect(right.areas).toHaveLength(2);expect(right.objects).toEqual(scene.objects);expect(right.connections).toEqual(scene.connections);
  const back=applyBoardNavigation(right,{areaId:'start'});expect(back.viewport).toEqual(scene.viewport);expect(applyBoardNavigation(back,{direction:'right'}).areas).toHaveLength(2);
  const below=applyBoardNavigation(back,{direction:'down'});expect(below.viewport?.y).toBe(795);
 });
 it('preserves Start and user-named areas when drawing into an empty region',()=>{
  const scene=board();scene.objects=[];scene.connections=[];
  const appended=appendIllustration(scene,project.scenes[1]!);expect(appended.areas?.find(a=>a.id==='start')?.label).toBe('Start');expect(applyBoardNavigation(appended,{areaId:'start'}).activeAreaId).toBe('start');
 });
 it('keeps camera navigation safe after the named-area limit',()=>{
  const scene=board();scene.areas=Array.from({length:200},(_,index)=>({id:`area-${index}`,label:`Area ${index}`,x:index*1320,y:0,width:1200,height:675}));scene.activeAreaId='area-199';scene.viewport={x:199*1320,y:0,zoom:1};const moved=applyBoardNavigation(scene,{direction:'right'});expect(moved.areas).toHaveLength(200);expect(moved.viewport?.x).toBe(200*1320);expect(moved.activeAreaId).toBeUndefined();expect(SceneSchema.safeParse(moved).success).toBe(true);
 });
 it('zooms around camera center and visits a distant existing target',()=>{
  const scene=board(),zoomed=applyBoardNavigation(scene,{zoom:'out'}),view=getSceneViewport(zoomed);expect(view.x+600/view.zoom).toBe(600);expect(view.y+337.5/view.zoom).toBe(337.5);
  scene.objects[0]!.x=5000;const visited=applyBoardNavigation(scene,{targetId:'client'});expect(visited.viewport!.x+600).toBe(5105);expect(visited.objects).toEqual(scene.objects);
 });
 it('appends without relocating old content and remaps duplicate IDs, connections and anchors',()=>{
  const scene=board(),generated=structuredClone(project.scenes[2]!);generated.objects.push({id:'chart',kind:'chart',label:'Chart',x:100,y:500,width:300,height:100,data:[1,2]},{id:'image',kind:'image',label:'Image',x:100,y:500,width:100,height:100,anchor:{kind:'x-axis',targetId:'chart'}});
  const first=appendIllustration(scene,generated),second=appendIllustration(first,generated);
  expect(first.objects.slice(0,scene.objects.length)).toEqual(scene.objects);expect(first.viewport!.x).toBe(1320);expect(second.viewport!.x).toBe(2640);
  expect(new Set(second.objects.map(o=>o.id)).size).toBe(second.objects.length);expect(new Set(second.areas?.map(a=>a.label)).size).toBe(second.areas?.length);expect(SceneSchema.safeParse(second).success).toBe(true);
  const lastImage=second.objects.filter(o=>o.kind==='image').at(-1)!;expect(second.objects.find(o=>o.id===lastImage.anchor!.targetId)?.kind).toBe('chart');
  expect(second.connections.at(-1)?.source).not.toBe('api');
 });
});
describe('whiteboard command boundaries',()=>{
 it('distinguishes camera motion, named navigation, object moves and drawing',async()=>{
  const scene=board(),resolve=(text:string)=>localResolve({text,scene,cues:[]});
  expect(resolve("let's go right")).toMatchObject({type:'navigate',navigation:{direction:'right'}});expect(resolve('scroll right')).toMatchObject({type:'navigate'});expect(resolve('go to Start')).toMatchObject({navigation:{areaId:'start'}});expect(resolve('move database right')).toMatchObject({type:'move',targetId:'database',dx:200,dy:0});expect(resolve('draw a matrix')).toMatchObject({type:'add_illustration',illustrationKind:'math'});expect(resolve('draw a software architecture')).toMatchObject({type:'add_illustration',illustrationKind:'architecture'});
  const live=createNebiusResolver({key:'test',model:'test',baseUrl:'https://example.test/v1'});expect(await live({text:'zoom in',scene,cues:[],signal:new AbortController().signal})).toMatchObject({type:'navigate',navigation:{zoom:'in'}});
 });
 it('skips unknown or ambiguous targets and excessive movement',()=>{
  const scene=board();scene.objects.push({...scene.objects[0]!,id:'client-two'});
  expect(localResolve({text:'move web client right',scene,cues:[]}).type).toBe('skip');expect(localResolve({text:'go to nowhere',scene,cues:[]}).type).toBe('skip');expect(localResolve({text:'move database right by 99999 units',scene,cues:[]}).type).toBe('skip');
  expect(validateProposal({type:'navigate',navigation:{direction:'right'},reason:'test'},project.scenes[0]!,'go right').type).toBe('skip');
 });
 it('waits for final speech before navigation, movement or generation',async()=>{
  const messages:ServerMessage[]=[],planner=vi.fn().mockResolvedValue({scene:project.scenes[1]!,source:'demo'}),session=new VisualSession(m=>messages.push(m),undefined,undefined,planner);memorySource(board()).attach(session);
  try{await session.cue('go right',false,true);await session.cue('move database right',false,true);await session.cue('draw a matrix',false,true);expect(actions(messages)).toHaveLength(0);expect(planner).not.toHaveBeenCalled();await session.cue('draw a matrix',true,true);expect(actions(messages)[0]!.action).toMatchObject({type:'add_illustration',source:'demo',viewport:{x:1320,y:0,zoom:1}});expect(actions(messages)[0]!.action.reason).toContain('predefined');expect(actions(messages)[0]!.action.objects!.length).toBeGreaterThan(0);}finally{session.close();}
 });
 it('cancels stale planning and accepts renderer ack after an ink/areas-only change',async()=>{
  const messages:ServerMessage[]=[];let release!:(value:any)=>void;let signal!:AbortSignal;const planner=vi.fn((_request,abort:AbortSignal)=>{signal=abort;return new Promise<any>(resolve=>release=resolve);}),session=new VisualSession(m=>messages.push(m),undefined,undefined,planner),scene=board(),src=memorySource(scene);src.attach(session);
  // The viewport is per-viewer and no longer part of the project source; an areas-only self commit still aborts planning but is not content.
  try{const pending=session.cue('draw an architecture');await vi.waitFor(()=>expect(planner).toHaveBeenCalled());const moved:Scene={...scene,areas:[...scene.areas!,{id:'next',label:'Next',x:1320,y:0,width:1200,height:675}]};src.set(moved);session.sync('self');expect(signal.aborted).toBe(true);release({scene:project.scenes[2]!,source:'demo'});await pending;expect(actions(messages)).toHaveLength(0);
   await session.cue('highlight database');const action=actions(messages)[0]!.action;src.set({...moved,ink:[{id:'stroke-1',color:'#e11d48',width:4,points:[10,10,40,40]}]});session.sync('self');session.applied(action.id);expect(messages.some(m=>m.type==='state'&&m.cueId===action.id&&m.state==='applied')).toBe(true);
  }finally{session.close();}
 });
 it('places new components relative to the current camera',async()=>{
  const messages:ServerMessage[]=[],session=new VisualSession(m=>messages.push(m));memorySource(applyBoardNavigation(board(),{direction:'right'})).attach(session);try{await session.cue('add a cache');expect(actions(messages)[0]!.action.object).toMatchObject({kind:'node',label:'Cache',x:1440,y:140});}finally{session.close();}
 });
});
