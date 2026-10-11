# Canvas implementation handoff

Owner: canvas agent. Implementation in `apps/web/src/canvas/SceneCanvas.tsx` and `canvas.css`.

## Design

The surface has a 1200 × 675 logical coordinate system scaled by ResizeObserver into a responsive 16:9 container. Saved object geometry remains independent of screen size. The visual language is ivory, evergreen, muted sage, serif editorial headlines, and red attention pointers.

Scene objects are the source of truth; renderer holds only transient drag geometry, effect expiry, and image loading state. `onChange` commits completed gestures. Presentation mode disables drag, resize, connect, and editor selection overlays. Node diagrams use React Flow with the same coordinate system, avoiding pan/zoom so pointer geometry stays consistent. ELK automatic layout is explicitly requested and rejects results if the scene changed while computing.

Objects: editable text, metrics, SVG bar charts, structured matrices, real images with failure states, graph nodes and connections. Matrix row/cell and chart bar IDs follow BUILD_CONTRACT.md. KaTeX is used for equation text beginning with `$` and matrix symbol labels, with trust disabled. Internal image parts are not inferred.

Effects resolve exact stable IDs by measuring rendered DOM bounds relative to the logical scene. Highlights/pointing expire after at least the action's declared duration; animated effects use cancellable Web Animations and connected diagram edges animate. Renderer callbacks acknowledge application only when the target exists; completion is reported only after animation completion. Replacement effects and scene changes clean up playback and timers.

## Integration

Default SceneCanvas component implements BUILD_CONTRACT.md. Dependencies: React, @vizli/shared, @xyflow/react, elkjs, katex, @types/katex. Canvas imports package CSS and its own styles. Parent applies persistent reveal/add/undo actions before passing the effect.

## Scope and limitations

- Matrix operations are visual targeting only; no symbolic algebra or correctness engine.
- Diagram animations emphasize components and connected edges, rather than implying a validated request sequence.
- Basic slide drag/resize commits once per gesture. Graph resize is available through the workspace inspector.
- Auto layout clamps to scene bounds; large graphs need future overflow/layout strategies.
- Images use browser loading; remote hosts may block loading. Parent validates import URLs/files.
- Reveal is persistent scene mutation owned by parent; rendering alone does not modify scene visibility.
- No arbitrary generated code executes in renderers.

## Progress and verification

Initial implementation complete. Type check and integrated browser verification pending workspace dependencies and shared types.

### Verification update

- `tsc -p apps/web/tsconfig.json --noEmit` passed after shared types and workspace components arrived.
- Reviewed fixture coordinates; backend moved objects below the scene header (`y >= 195`) and above the footer (`y < 625`). Matrix symbols A/B and equation LaTeX now render intentionally.
- Added column targets `${id}:col:${column}`. Columns resolve the union of actual cell DOM rectangles; row/cell/bar targets use their own DOM rectangle. Pointer position uses `(targetClientRect - stageClientRect) / responsiveScale`, preserving the 1200 × 675 logical space at all viewport widths. For columns, animation applies to every cell in the column.
- Added `scene-canvas` and `visual-effect` test IDs and `data-object-id` attributes for integrated acceptance tests. Overlay records the semantic target ID.
- Effect acknowledgements use bounded action-ID sets to avoid duplicate application/completion reports on viewport changes. Resizing the viewport updates geometry without restarting playback.
- Reduced-motion preference reduces Web Animations duration and disables CSS edge animations.
- Browser QA pending root acceptance suite; local Chrome channel is available if the bundled Playwright browser is absent.

## Integration update
Root added optional `selectable` prop, defaulting to `editable`, so Rehearse can select objects without allowing drag/resize. Present disables both.

### Final browser review and loading optimization

- Reviewed marketing, math, and architecture screenshots in real Chrome at 1440 × 1000. Content fits below headers and above footer. Matrix B label, KaTeX derivation, readable metric trend notes, and chart axes verified.
- Typed “Point to second column of matrix A” and verified `matrix-a:col:1` highlights exactly the two cells in that column with a red pointer.
- Corrected React Flow drag under responsive scaling: its wrapper compensates for the outer stage transform, while React Flow receives the real viewport zoom. This keeps its pointer arithmetic and SVG edge geometry in agreement. Browser drag of 40 × 20 screen pixels moved the node exactly 40 × 20 pixels; undo restored it. `nodeDragThreshold=0` avoids dropping the first movement segment.
- ELK is dynamically imported only when Auto arrange is requested, reducing initial load. Graph behavior and scene model are unchanged.
- Root added separate `selectable` permission so rehearsal can choose cue targets without enabling edits; presentation remains non-selectable.

### Web-image anchoring on chart axes

- Images may retain `anchor: {targetId, kind: 'x-axis'}` and search provenance in `imageSource`. Canvas uses shared `resolveImageAnchor` against the current draft scene every render, so anchors follow live chart dragging, resizing, and positive/negative data changes. The chart SVG begins exactly 44 logical pixels below its object top; its axis is `22 + baseline` inside SVG, with `plotHeight = max(40, chart.height - 100)` and baseline half that for mixed/negative data, otherwise the full height.
- Explicit x-axis line is rendered with `data-chart-axis`. Anchored images are centered on the chart, bottom aligned to that line. Images use `object-fit: contain` with bottom alignment; no image cropping or distortion is introduced. Anchored image wrappers are transparent and omit overlaid captions, preserving the bottom alignment. Provenance editing/display remains with the workspace inspector.
- Manual image dragging detaches the anchor and commits its displayed coordinates; resize preserves anchoring. Clicking without moving does not detach. Undo is owned by the workspace and restores prior anchors normally.
- Browser QA used an isolated chart/image fixture with server writes intercepted: image bottom/axis position difference was exactly 0 pixels, moving the chart by 30 × 20 screen pixels moved its image by 29.997 × 19.992 (fractional layout rounding), and manually dragging the image removed its anchor in persisted local JSON. Web typecheck passed.

### Infinite whiteboard surface

Whiteboards are opt-in with `scene.layout === 'whiteboard'`; missing layout preserves existing slides. Scene camera `viewport: {x,y,zoom}` stores top-left world coordinates and zoom 0.25–2. The viewport is always 1200 × 675 logical screen pixels. No giant bitmap or million-pixel canvas is allocated. HTML/SVG objects near the viewport (200 logical screen pixels of overscan) are mounted; far objects remain only in the saved scene.

`useBoardCamera.ts` owns transient navigation. Its XState machine transitions idle → panning → idle for background/Space/middle-button gestures and idle → navigating → idle for wheel bursts. Background drag pans, wheel scroll pans, and Ctrl/Meta-wheel zooms around the pointer. Pointer deltas convert through `responsiveScale × camera.zoom`. Camera updates commit once on gesture end or after 180 ms of wheel inactivity. Scene changes cancel pending commits. View navigation remains enabled while presenting; object editing remains gated by `editable`. Workspace owns zoom/navigation buttons; canvas provides only a small interaction hint.

Whiteboard object world transform is `translate(-camera.x * zoom, -camera.y * zoom) scale(zoom)`. Object dragging permits world coordinates ±1,000,000 and removes slide-boundary clamping. Anchored image geometry resolves in world space. Existing semantic matrix/chart targets remain unchanged. Attention overlays remain in logical screen space, measuring actual transformed target DOM rectangles so pointers follow pan/zoom. Parent should navigate offscreen targets before dispatching attention actions and preserve effects on camera-only commits where appropriate.

`BoardBackdrop.tsx` renders named area outlines and Bézier connection paths into a viewport-sized SVG. Whiteboard architecture uses the existing editable HTML node representation, avoiding a second nested React Flow camera. Slide architecture retains React Flow. Headers and footers are slide-only. Named regions do not create separate documents or copies of objects. Graph connection creation on whiteboards is currently owned by the parent/controller; direct connection-handle drawing remains available only in slide React Flow scenes.

Browser checks in Chrome at 1440 × 1000: an object at zoom 0.5 moved 39.997 × 19.996 screen pixels for a 40 × 20 drag; a 30 × 20 background drag moved the content exactly 30 × 20. A far object at world coordinate 800,000 was not mounted. Workspace zoom controls updated the camera and board remained navigable in Present mode. Root supplies integrated offscreen-navigation/pointer acceptance tests. Web typecheck passed.

Automated gesture regression: `pnpm exec playwright test tests/whiteboard-gestures.spec.ts` passes. It seeds an isolated project, checks offscreen culling, wheel pan, pointer-centered Ctrl-wheel zoom, Space-drag over an object, plain background drag, unchanged object geometry, and camera persistence across reload. It does not send cues or make paid provider calls. The same deterministic fixture captures `docs/screenshots/whiteboard.png` before gestures.

### Matrix edits and density

Voice/manual matrix edits keep the original object bounds and semantic IDs. A fixed-cell-size overflow bug was corrected: cell font size, spacing, and padding now scale together using row count, maximum numeric text length, and available object width/height. In an isolated browser render at 340 × 230 logical pixels, 2×2, 3×2, and 5×5 matrices retained all 4/6/25 cells within the object bounds; font sizes were 27/22.5/14.0625 pixels respectively. The last IDs remained `matrix-a:cell:1:1`, `:2:1`, and `:4:4`; coordinate IDs refer to cell positions, not immutable numeric values. Row/column highlights continue to resolve actual bounds.

Very dense matrices or extremely small object bounds may be illegible even when contained; users should enlarge the object. This renderer does not recalculate authored derivations, explanatory labels, or downstream matrices when values change. Existing derivation text can become stale and should be reviewed; no silent mathematical computation or correctness claim is made.

### Full viewport workspace

`SceneCanvas` accepts `fillViewport?: boolean` (default false for existing embeds). With a full-size parent, the shell has no fixed aspect ratio. Slides retain their 1200 × 675 authored page, fit the smaller width/height scale, and center within available space; their decorative footer is omitted in this mode. Whiteboards occupy the entire measured parent: logical width stays 1200 and logical height becomes `parentHeight / (parentWidth / 1200)`. Board culling, region/connection SVG, attention overlay, wheel page deltas, and pointer clamping use that actual logical height. Resizing does not change objects or persisted camera coordinates.

Attention measurements subtract the centered stage rectangle, preserving pointer alignment on letterboxed slide pages. Graph interaction continues to compensate for outer scaling. Wheel zoom uses the actual pointer position; named-area navigation and workspace toolbar zoom remain defined by the shared 1200 × 675 area contract, not a promise to center the entire viewport.

Isolated Chrome verification: whiteboard filled 1440 × 700 and 600 × 1000 parents (subpixel error below 0.01 px). A lower object at world y=1200 was correctly culled in landscape and rendered in portrait. The same portrait viewport fitted its slide to 600 × 337.5 at y=331.25; attention-ring center error was 0 px. Parent `onChange` was called zero times during all viewport resizing. Web TypeScript check passed.

### Domain modules, semantic parts, and motion adapters

The host no longer switches on object kind to draw content. `renderers/registry.tsx` dispatches every object—including existing core objects and React Flow node contents—through a trusted renderer registry, using shared `getObjectPlugin`. `renderers/core.tsx` owns text/metric/chart/image/generic node renderers, `renderers/math.tsx` owns matrix and whole-equation rendering, and separate AWS/UML modules own their visual and internal-part structure. Project data selects compiled-in plugin IDs; it cannot install or execute arbitrary renderers.

- Math matrix preserves positional row/cell IDs. Column membership is authored by the matrix module through generic `data-target-groups`; `semanticTargets.ts` resolves direct IDs or grouped membership without understanding matrix suffixes. Equation objects use KaTeX even when compact; arbitrary internal equation terms are not inferred.
- Text objects under 100px tall use compact title/body typography so their full copy can fit inside the saved bounds; very short text objects continue to render as a single compact span.
- AWS nodes expose service and configured-region targets. The renderer uses locally bundled, unmodified AWS Architecture Icons SVGs from the official July 2026 package for API Gateway, Route 53, ALB, EC2, RDS, Lambda, S3, and DynamoDB. [`apps/web/public/aws-icons/README.md`](../apps/web/public/aws-icons/README.md) records package paths and provenance; these AWS marks are not Apache-2.0 project artwork. A generic client node is not assigned an AWS icon. Service labels describe diagram components only and do not claim infrastructure provisioning.
- Narrated AWS request-flow cards remain ordinary editable scene objects with stable object and connection IDs. The renderer exposes `data-aws-service`, `data-aws-icon`, and semantic capacity/replica attributes for browser inspection. Geographic/latency routing is shown as a Route 53 policy decision with an editable best-effort DNS explanation; it does not depict Route 53 as an inline HTTP proxy. The EC2 Auto Scaling card's 5–12 label states a configured range and does not claim that 12 nodes are running. A replica group labeled “multiple” does not assert an unspecified replica total.
- The AWS request-flow planner uses a compact 880 × 400 world-space footprint. On whiteboards it places/reframes the complete graph into the unobstructed screen region x=290–1170 and y=115–580 at the current zoom, preserving the graph's world coordinates as the camera moves. If the current zoom cannot fit the flow beside workspace controls, the planner asks the user to zoom out. On finite slides it starts below the authored title band and keeps the graph within the 1200 × 675 page.
- UML class nodes expose title, attributes/methods compartments (including empty compartments), and each indexed attribute/method. Compartment contents remain editable project data. Long individual rows truncate visually within fixed bounds.

`motion/adapters.ts` is independent of domain names. It animates generic `data-motion-item`, `data-motion-group`, and `data-motion-stroke` markers authored by renderers. Shared finite presets are pulse (900 ms), draw (1400 ms), and flow (1800 ms). Draw traces matrix bracket paths and reveals cells in order; above 80 items it reveals authored groups to bound animation count. Glyphs use reveal effects, not simulated pen trajectories or claimed real handwriting. Flow emphasizes the target and animates connected edges only for its bounded playback lifetime.

Applied/completed acknowledgements remain separate and deduplicated. Replacing actions, changing scenes, or unmounting cancels Web Animations and suppresses stale completion. Reduced-motion uses 1 ms transitions. Motion does not mutate cells, object geometry, or plugin data. Effect overlays expose `data-motion-preset` for inspectability. Root owns `tests/plugins.spec.ts` covering targets, cancellation, completion, reduced motion and persistence. Web TypeScript validation passes after refactoring.

Isolated CUA visual review confirmed a default matrix, AWS Lambda node, and UML class rendered together on a whiteboard with readable cells, unbroken bracket paths, clear compartment dividers, and no clipping or overlap. The temporary direct-render HTML and browser tab were removed afterward; no saved user projects were changed. Parent reports the integrated plugin acceptance tests pass after the generic target-group refactor.

### Explicit Hand tool

`panTool?: boolean` defaults false. On whiteboards, Hand mode captures primary pointer-down at the stage before child object drag/resize handlers and pans even when the gesture begins over a card, matrix cell, or resize handle. Space and middle-button gestures use the same capture path; Select still permits object editing and empty-background panning. Panning suppresses the following object click so it cannot change selection. Slide interaction remains separate. Navigation still follows the existing idle/panning/navigating XState machine and persists the camera only when a gesture finishes.

Stage touch-action prevents browser scrolling during canvas gestures. A pan tracks one primary pointer; additional touch pointers cannot change or complete that gesture. Pointer cancellation, unexpected capture loss, or window blur rolls the transient camera back and cleans listeners. Camera rendering remains viewport-sized with world-object culling (coordinates up to ±1,000,000), with no large bitmap allocation. Web TypeScript check passed; root owns integrated Hand/surface-switch browser verification.

### Narrated presentation frames

`presentation?: {token, step, paused}` and `onPresentationComplete(token)` expose a reusable frame lifecycle for shared `PresentationStep` data. The controller applies scene changes first in the same React commit. `PresentationLayer` starts grouped insert draws after semantic targets mount, waits for all actual animations, traces or highlights multiple semantic targets, and acknowledges camera steps only after the rendered camera reaches the persisted destination. React Flow may commit controlled node DOM one or more frames after the scene update, so insert draws retry target lookup for at most 30 animation frames before reporting a missing/offscreen target; token replacement, pause, scene changes, and unmount cancel the pending lookup and suppress stale completion. `onPresentationError(token, reason)` reports missing insert/attention targets instead of falsely completing or hanging; an unsettled camera has a 15-second active-time limit. Wait/context timing belongs to the parent sequence controller.

`motion/attention.ts` draws a finite red (or configured-color) outline with a moving head around measured target bounds. Highlights gently fade in over up to 220 ms. Bounds remain screen-space and remeasure on camera/viewport/object changes; row and column groups require no matrix-specific attention logic. Draw, trace and highlight playback pause/resume. Reduced motion uses near-instant updates. Existing ordinary actions also accept configured color and duration. Newly inserted objects with `motion: draw` have a generic prepaint entrance; presentation frames take precedence to avoid duplicate playback.

External camera updates ease over 420 ms by default (presentation camera duration overrides this); direct pointer and wheel gestures stay immediate and interrupt interpolation. Animation updates only local rendered camera, never object coordinates or repeated persisted writes. Symbolic string matrix cells use trusted-disabled KaTeX; simple a11/a_11 forms normalize to subscript notation. Long expressions shrink under existing density sizing and can require larger authored bounds for legibility. Authored equations remain explanatory content, not silently evaluated by the renderer.

Isolated actual-planner visual review found and corrected an initially clipped product card (planner compacted the layout), disappearing blank-result row height, and symbolic cell width jitter. Empty cells now reserve a line box and indexed-symbol width so the result matrix brackets remain stable while entries appear. Per-cell `math.expressions` are available as tooltips and accessible labels; compact c11 notation remains legible. Simultaneous row/column highlights were visually verified against actual matrix DOM geometry. Cancellation during camera movement stops interpolation and snaps to the already-committed scene destination; it does not leave background playback running.

Final isolated CUA review of the actual planner's 3×2 A / 2×3 B sequence confirmed the compacted product card ends near screen y=580 at width 1512, leaving room below in the approximately 680-pixel-high workspace. Both source matrices, the indexed current dot-product equation, and all nine result cells remain visible. The midstep preview confirmed blank and populated result brackets have stable height and simultaneous row/column highlights cover the correct cells. Temporary HTML/JSON fixtures and review tabs were removed without modifying a saved project. Update steps can now specify generic `entranceTargets` to reveal only the newly calculated cell and explanatory equation, leaving completed result cells visible. Equation text scales to its authored width before paint to avoid long-expression clipping.
