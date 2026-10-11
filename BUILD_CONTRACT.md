# Vizli implementation contract

Historical coordination contract for the first implementation. All agents finished; no exclusive ownership remains. See docs/STATUS.md for current behavior, verification, and next steps. PLAN.md is product context.

## Ownership
- backend agent: apps/server/**, packages/shared/** (including package manifests).
- canvas agent: apps/web/src/canvas/** only.
- workspace agent: apps/web/** excluding src/canvas/**; includes web package manifest.
- root: root configuration, integration, docs, acceptance tests.

## Stack
React, TypeScript, Vite; Fastify websocket server; XState; SVG/HTML, React Flow, ELK, KaTeX; Zod; NVIDIA hosted ASR and Nebius adapters. Working offline/local demo without credentials, explicitly labelled Demo (never claim model inference). Credentials server-only via .env. No deployments or commits.

## Shared types (backend agent implements packages/shared/src/index.ts)
SceneObject: { id:string; kind:'text'|'metric'|'chart'|'matrix'|'image'|'node'; label:string; x:number; y:number; width:number; height:number; color?:string; text?:string; value?:string; data?:number[]; labels?:string[]; cells?:number[][]; src?:string; hidden?:boolean; aliases?:string[] }
Scene: { id:string; title:string; subtitle:string; kind:'slide'|'math'|'architecture'; objects:SceneObject[]; connections:{id:string;source:string;target:string;label?:string}[] }
Project: { id:string; title:string; scenes:Scene[]; cues:{id:string;sceneId:string;phrase:string;targetId:string;action:'highlight'|'point'|'reveal'|'animate'}[]; updatedAt:string }
VisualAction: { id:string; type:'highlight'|'point'|'reveal'|'animate'|'clear'|'add_node'|'undo'; targetId?:string; label?:string; reason:string; sceneId:string; revision:number }
Effect: { action:VisualAction; startedAt:number }
Exports: types above plus createDemoProject():Project. Package name @vizli/shared.

## Canvas component contract
apps/web/src/canvas/SceneCanvas.tsx default export:
props { scene:Scene; effect:Effect|null; selectedId:string|null; editable:boolean; selectable?:boolean; onSelect:(id:string|null)=>void; onChange:(scene:Scene)=>void; onApplied?:(actionId:string)=>void; onAnimationComplete?:(actionId:string)=>void }
Canvas logical space 1200x675. Responsive 16:9. No global state or persistence. Subtle tasteful emerald/cream visual style; scene surface ivory white. Structured matrices cell IDs `${object.id}:cell:${row}:${col}`, rows `${object.id}:row:${row}` (zero based). SVG charts target individual bars `${object.id}:bar:${index}`. Parent and nested targets supported. React Flow for architecture. Persist node drag. Real image elements with failure handling. KaTeX for matrix-related equation text if applicable. Component includes its own canvas.css.

## API/WebSocket contract
GET /api/status → {mode:'demo'|'live',speechConfigured:boolean,modelConfigured:boolean,model:string|null}
GET /api/projects/default → Project (local file persistence)
PUT /api/projects/:id body Project → {ok:true}; validate request
WS /api/session, JSON messages:
client {type:'scene',scene:Scene,revision:number,cues:Project['cues']}
client {type:'cue',text:string,source:'typed'|'demo',mode:'editing'|'rehearsing'|'presenting'}
client {type:'listen',enabled:boolean}; subsequent binary PCM16 LE mono 16k audio
client {type:'applied',actionId:string}; {type:'animation.completed',actionId:string}
server {type:'ready',mode:'demo'|'live'}
server {type:'transcript',text:string,final:boolean}
server {type:'state',state:string,cueId?:string}
server {type:'action',action:VisualAction}
server {type:'skipped',reason:string}
server {type:'error',message:string}
server {type:'speech',state:'listening'|'off'|'error'}
Server state/revision gating, cancellation, strict actions, scene target validation, and ambiguity skip mandatory. Local deterministic resolver for demo and obvious explicit commands. If configured, actual Nebius inference and NVIDIA speech are functional. Partial speech cue processing and dedupe. Mode rehearsal memory can be saved frontend as Project.cues.

## UI
Professional polished workspace, ivory background, evergreen sidebar/navigation, serif scene headline paired with clean UI sans. Header title and saved state, Edit/Rehearse/Present controls. Left filmstrip scenes (marketing, maths, architecture), central canvas, right assistant panel with live transcript, demo cue chips, text input and action feedback. Bottom microphone/presentation controls. Basic object inspector: label/text/value/color/size; delete and undo. Add text, matrix, image via URL/file; new scene. Rehearsal cue binding to selected object, project import/export JSON, local persistence/API autosave, present mode audience canvas. Clear provider configuration UI and functional demo tour. No fake active microphone or unimplemented controls.
