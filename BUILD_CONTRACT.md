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
props { scene:Scene; effect:Effect|null; selectedId:string|null; editable:boolean; selectable?:boolean; fillViewport?:boolean; panTool?:boolean; presentation?:PresentationFrame|null; onPresentationComplete?:(token)=>void; onPresentationError?:(token,reason)=>void; onSelect:(id:string|null)=>void; onChange:(scene:Scene, base:Scene)=>void; camera:BoardViewport; onCameraChange:(camera:BoardViewport)=>void; onApplied?:(actionId:string)=>void; onAnimationComplete?:(actionId:string)=>void; inkTool?:InkTool|null; onInkChange?:(scene:Scene, base:Scene)=>void; presence?:PeerStore; presenceMode?:'all'|'presenter-only'|'none'; onCursor?:(point:{x,y}|null)=>void }. `base` is the exact snapshot `scene` was derived from (three-way commit into the shared Yjs document). Camera is per-user view state, not part of the scene. Presence props (`presence`, `presenceMode`, `onCursor`) render remote cursors and selections; they are optional and omitted means no presence layer.
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

## Collaboration (12 October 2026; details in docs/COLLAB.md)
- Shared document: `packages/shared/src/ydoc.ts` exports `PROJECT_ROOT`, `PROJECT_DOC_SCHEMA`, `LocalOrigin`, `cleanValue`, `canonicalScene`, `canonicalProject`, `fromPlain`, `toPlain`, `createPlainCache`, `applyDiff` (returns `{changed, skipped}`), `repairProject`, `observeProject`, `RepairError` and limits `MAX_SCENES`/`MAX_OBJECTS`/`MAX_CONNECTIONS`/`MAX_AREAS`/`MAX_CUES`. Plain `Project` values are derived snapshots; per-user viewport and `activeAreaId` stay in localStorage (`apps/web/src/collab/useLocalViews.ts`).
- Client hook: `useCollabDoc(projectId: string, _identity?: Identity)` (`apps/web/src/collab/useCollabDoc.ts`) returns the snapshot `{project, issues, status: 'loading'|'cached'|'connecting'|'live'|'offline', undoCount, redoCount, docId, joinEpoch, joined, storageFull, peers}` plus `commit(next: Project, options?: {base?, source?: 'user'|'ai'|'sequence', sequenceId?}) => {ok, skipped, error?}`, `undo()`, `redo()`, `beginSequence`/`endSequence`, `onRemoteChange`, `send(message)`, `sendAudio(bytes)`, `getProject()`, `setViewScene(sceneId)`, `setPresence(patch)`, `peerStore`, `awareness`, `identity`.
- Client modules: `apps/web/src/collab/` `identity.ts`, `transport.ts` (socket and reconnect), `provider.ts` (sync and awareness), `useCollabDoc.ts`, `useLocalViews.ts`, `useCursorPublisher.ts`.
- Server modules: `apps/server/src/collab/rooms.ts` (`RoomRegistry`, `DocRoom`), `apps/server/src/collab/limits.ts` (`collabLimitsFromEnv`, `ByteBucket`, `CountWindow`).
- Wire, one socket on `/api/session`. Text JSON: client `join {projectId, userId, clientId, name, color, sceneId?, seed?, token?}`, client `view {sceneId}`; server `joined {projectId, docId, version}`, server `effect {action, clientId, name}`, server `error {message, code?}`. The old `scene` snapshot message is removed.
- Binary frames carry a varuint channel prefix: 0 y-protocols sync (both directions), 1 awareness (both directions), 2 raw PCM16 audio (client to server).
- Join order: `ready`, `join`, `joined`, server sync step 1 and awareness states, client sync step 1, step 2 exchange, then updates.

## UI
Professional polished workspace, ivory background, evergreen sidebar/navigation, serif scene headline paired with clean UI sans. Header title and saved state, Edit/Rehearse/Present controls. Left filmstrip scenes (marketing, maths, architecture), central canvas, right assistant panel with live transcript, demo cue chips, text input and action feedback. Bottom microphone/presentation controls. Basic object inspector: label/text/value/color/size; delete and undo. Add text, matrix, image via URL/file; new scene. Rehearsal cue binding to selected object, project import/export JSON, local persistence/API autosave, present mode audience canvas. Clear provider configuration UI and functional demo tour. No fake active microphone or unimplemented controls.
