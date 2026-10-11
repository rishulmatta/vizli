# Vizli workspace implementation and handoff

Updated: 11 October 2026 (chronological sections below; first authored 8 October 2026). Owner: workspace agent. This document describes implemented UI, not future product guarantees. See BUILD_CONTRACT.md for renderer/wire boundaries and PLAN.md for product decisions. Root agent maintains overall acceptance and provider status.

## Implemented design

React/TypeScript/Vite workspace in `apps/web`. Evergreen navigation rail, warm ivory surfaces, restrained green accents, Instrument Serif headlines and DM Sans controls. Fonts are optional Google Fonts network requests with local serif/sans fallbacks. Filmstrip on left, structured scene center, assistant/inspector on right. Responsive at 390 px without page overflow; mobile scene strip scrolls internally. Reduced-motion preference disables CSS animation.

Three explicit XState machines are defined in `src/lib/machines.ts`:

- Mode: editing → rehearsing → presenting, with explicit transitions back. Escape exits present mode.
- Connection: connecting → ready → reconnecting. Exponential reconnect backoff capped at 10 seconds; fresh scene snapshot sent after ready handshake.
- Audio input: off → requesting → listening; provider acknowledgement establishes listening. Failures transition to unavailable. Stop/reconnect tears down stream/context; cancellation token prevents permission prompts resolving into stale capture.

The server owns cue interpretation/action lifecycle. UI displays server states and acknowledgement is reported by SceneCanvas. Scene revision increments on project/scene changes; outdated actions are discarded. Attention effects expire after 6.5 seconds; animation completion comes from renderer.

## Working user paths

- Prepared marketing, mathematics, architecture scenes from shared seed.
- Scene navigation, add scene, edit project title, Edit/Rehearse/Present modes.
- SceneCanvas selection, drag/resize and graph editing (owned by canvas agent).
- Inspector edits label, text/value, dimensions/color, matrix cells, chart values/labels, image URL, and hidden state.
- Add text, chart, matrix, graph node, or image (HTTP(S) URL or PNG/JPEG/WebP/GIF file ≤4 MB).
- Object deletion also removes attached connections and remembered cues (including nested targets).
- Up to 60 project snapshots support undo. Keyboard Cmd/Ctrl+Z ignores focused text input.
- Rehearsal phrase binding to selected object and highlight/point/reveal/animate action. Saved as project cues, not timed replay.
- Typed cues, suggested demo cues, transcript/activity log, action state. Demo mode explicitly says local rules and no AI inference.
- Project JSON export/import validated by shared ProjectSchema; malformed import leaves project unchanged.
- Device-local persistence and debounced API file persistence. Initial server project fetch only if local storage is absent; nothing is persisted until that initial read settles. Every commit is validated against `ProjectSchema` and refused with a notice when invalid; an unreadable stored project is preserved under `vizli.project.invalid` rather than silently replaced (11 October 2026).
- Provider configuration dialog distinguishes configured credentials from successful live connection. No credentials in browser.
- Three-step introductory tour.
- Root agent integrating generated-scene modal and optional Supabase CloudSync separately; inspect those modules for final scope.

## Audio implementation

`src/lib/audio.ts` requests a mono microphone stream and creates an AudioWorklet. `public/pcm-worklet.js` performs streaming linear interpolation from actual AudioContext sample rate to 16 kHz. It retains interpolation state across render blocks and emits 1,280-sample (80 ms) signed PCM16 packets. Output audio graph is muted. Context, nodes, tracks are cleaned on stop/failure/unmount. Browser drops upload packets if WebSocket buffered amount exceeds 128 KB (bounded backpressure, not durable audio delivery).

Microphone button opens setup dialog if hosted NVIDIA Nemotron ASR isn't configured. UI enters listening only after server `speech:listening`; browser permission success alone does not claim provider readiness. Disconnect explicitly stops capture. HTTPS or localhost required by getUserMedia.

No audio is stored by the frontend. Transcript and session log are in memory only. Saved project contains scene objects and user-created cue bindings.

## Source map

- `src/App.tsx`: project controller, workspace, inspector, dialogs, transport wiring.
- `src/styles.css`: responsive design, component states, reduced-motion rules.
- `src/lib/machines.ts`: independent XState mode/connection/input lifecycle machines.
- `src/lib/audio.ts`: microphone lifecycle and AudioWorklet setup.
- `public/pcm-worklet.js`: streaming PCM conversion.
- `src/canvas/**`: canvas agent’s renderer; do not replace stable target IDs with transient DOM IDs.
- `src/cloud/**`: optional cloud sync agent’s work.
- `src/generation/**`: root agent’s scene-generation dialog.

## Validation performed

- `pnpm --filter @vizli/web typecheck` passed.
- Root reported all four initial Playwright tests passing: marketing cue + nested matrix row + architecture rendering; inspector edit/undo/present/Escape; API malformed project rejection; 390 px viewport no page overflow.
- Root visually inspected desktop/mobile screenshots and reported polished rendering.
- AudioWorklet VM harness: one second of input at 44,100/48,000/16,000 Hz produces 16,000/16,000/15,999 samples respectively, with all emitted packets exactly 1,280 samples. Constant input 0.25 produces signed sample 8192. One-sample deficit at 16k is interpolation look-ahead, retained across blocks.
- Live microphone/provider session requires credentials and a real microphone: not claimed tested.

## Known boundaries / next agent work

- `App.tsx` intentionally concentrates initial integration; extract project/transport/audio hooks when adding substantial features. Do not fork authoritative scene state into renderer-specific stores.
- Project edits currently push history on each input change; grouping an entire focused field edit into one undo transaction would improve typing behavior.
- Scene thumbnails are lightweight illustrative summaries, not full renderer screenshots.
- Presentation mode hides editing/filmstrip but retains private-style controls and assistant on the same display. A separate audience window is future work.
- Image uploads are embedded data URLs; near browser storage limits, local save reports a warning. Object storage upload/asset lifecycle should replace this for larger libraries.
- Matrix values are editable/renderable with explicit atomic Apply and finite rectangular validation; chart Apply validates paired values/labels. No automatic math validation or derivation engine.
- Saved cue management supports adding and a current-scene list with removal/undo. Nested-part cue authoring and editing existing phrases remain future work. Shrinking matrix/chart data prunes invalid nested cue references.
- Workspace settings/image/tour/scene modals include keyboard focus trapping/restoration. Comprehensive screen-reader audit remains to do.
- Browser reconnect restores scene snapshot, not transcript/action event history. No claim of durable live-session resume.
- Provider settings check configuration, not authentication or latency benchmarks.
- Imported decks are Vizli JSON only. Arbitrary PowerPoint/PDF reconstruction is not implemented.

## Final editing pass

Scene toolbar settings opens title/subtitle editor with explicit Save. Matrix/chart controls moved to `src/editor/ObjectDataEditor.tsx`: local draft, explicit Apply, finite-number validation, rectangular matrices up to 30×30, matching chart labels up to 200 values. All data applies in a single undoable transaction. Current-scene remembered cue list supports remove/undo. Rehearsal keeps objects selectable without drag editing. Header wraps on narrow viewports while retaining Cloud/CreateScene controls.

Validation: three additional Playwright tests in `tests/editor.spec.ts` passed (matrix rejection/apply/undo, chart label validation and scene metadata save, remembered cue remove/undo). Mobile 390px overflow regression test passed after cloud/generation header integration. Tests use unique seeded project IDs to avoid overwriting the default project.

## Search-and-place image integration

Marketing cue suggestion now includes “An apple on the x axis.” The server's `searching` cue state displays “Searching Wikimedia Commons…” and skip/error explanations stay in session activity. Local demo interpretation is explicitly distinguished from live Commons image retrieval (no key required).

Frontend handles `add_image` actions only after the existing scene/revision guard. It requires an image object, rejects duplicate IDs, validates the proposed complete SceneSchema, commits the image through normal project history/persistence, selects it for inspection, and acknowledges the applied action. Undo removes the added image. Stale images from an earlier scene are not inserted.

Image inspector shows anchor target label, source-page link, original query, attribution and license when supplied. Text metadata is rendered as plain React text. Manually replacing an image URL clears old source attribution. Canvas agent owns anchor geometry, chart-relative movement and manual drag detachment. Backend owns real Commons search/result selection and skips scenes with no usable or ambiguous x-axis.

Validation: frontend typecheck passed after shared add_image contract integration. Network/provider end-to-end image tests and canvas placement acceptance are coordinated by root; do not equate mocked retrieval tests with verified public-network access.

## Hosted NVIDIA speech selection

User-selected speech provider is now hosted NVIDIA Nemotron ASR. Connection setup names `NVIDIA_API_KEY` alongside `NEBIUS_API_KEY` and `NEBIUS_MODEL`. Nebius Token Factory remains the primary Nemotron agent inference path; hosted NVIDIA speech is the audio transcription provider. Browser capture still sends mono 16 kHz PCM to the server adapter. Configuration status means environment configuration only, not verified credentials or a tested live provider session. Backend implementation and provider endpoint setup are maintained by the backend agent.

## Whiteboard extension

New whiteboard entry in the scene filmstrip creates a separate blank world (`layout:whiteboard`, `kind:slide`) with a 1200×675 Start area and camera at 0,0,1. Original three default scenes stay unchanged. `editor/WhiteboardControls.tsx` exposes four-direction panning, zoom/reset, named-area return and naming the current viewport. Shared navigation helpers own camera semantics; world objects remain in their stored coordinates. UI navigation and edits persist through normal project history and are undoable.

Object insertion uses the current whiteboard camera rather than original slide origin. Create-from-idea switches to “Add an illustration” and appends through the shared layout helper, preserving existing board objects. Scene-keyed generation component aborts pending generation when moving to another scene. Live Nemo inference versus demo template labels remain explicit.

Client consumes `navigate`, `move`, and prepositioned `add_illustration` action payloads through the existing scene/revision checks. Illustrations merge objects, connections, named area and camera, with SceneSchema validation before commit. Node insertion accepts the server-positioned object. Board highlight/point actions bring their target into view and queue the effect until the camera project update completes. Backend preserves dispatched acknowledgement eligibility across camera-only changes so the renderer can report application without stale-action loss. Both microphone transcripts and typed commands share the server cue path.

Canvas agent owns whiteboard pan/zoom gestures, coordinate transforms, SVG graph connections, renderer target measurements and world bounds. Backend owns deterministic navigation intent, model planning, generated scene append layout, schemas and helper functions. Browser whiteboard acceptance is coordinated by root; do not infer a pass from these implementation notes alone.

## Voice amendments to existing objects

Frontend `edit_object` actions call the shared `applyObjectEdit(scene, targetId, patch)` helper after the existing scene/revision guard. A validated edit commits once to project history, preserving object IDs and making undo atomic. The client acknowledges only successful application; incomplete or invalid patches leave the scene unchanged and display an activity error. Matrix scene suggestions now include “Make matrix A 3 by 2” alongside row highlighting and step reveal. Both typed and microphone-derived commands use the same server action path.

Shared/backend own allowed fields and parsing: text/labels/metric values, geometry, rectangular matrix size, and individual matrix cell values. Matrix resizing preserves overlapping values and fills new cells with zero. Frontend does not duplicate mutation logic or generate extra objects when editing an existing target. Provider-specific voice accuracy remains subject to real microphone/ASR validation.

## Canvas-first floating workspace (9 October)

The canvas now fills the viewport. The original navigation rail, workspace page header, marketing introduction, memory footer and fixed side columns have been removed from rendered UI. Branding is a small Vizli wordmark at upper left beside editable project title and current scene. Floating modes and project menu sit upper right. Compact object/history/scene controls float near the top; whiteboard controls remain a small floating group. The microphone and editable typed instruction field stay visible in a bottom dock, with optional latest transcript and a small provider/state label.

Scenes open on demand using `scenes-toggle` (Open scenes). Selecting a scene closes the flyout. Import/export, cloud sync, scene generation and connection setup remain available in `project-menu-toggle` (Open project menu). Files are mounted in an inert hidden menu so cloud/auth state is preserved; generation dialogs retain viewport-fixed geometry. Session suggestions/history/remembered cues open with `activity-toggle`. Object selection automatically opens the floating inspector. Escape closes flyouts/selection and exits presentation as before. Mobile retains all actions through the same compact buttons and scrollable panels rather than hiding functionality.

SceneCanvas receives `fillViewport`; renderer agent owns world/camera dimensions, centered finite slide fit and actual canvas hit regions. App `.stage-frame` is positioned inset zero at full viewport size. Overlay panels do not consume canvas layout space. Existing action test IDs are preserved behind their corresponding flyout; browser tests must open panels first. Frontend typecheck passed; root owns screenshot/mobile acceptance of this redesign.

## Domain plugin UI (10 October)

Floating Add object menu now includes a compact, expandable domain library driven by shared `BUILTIN_PLUGINS`. Mathematics provides matrix and equation presets; AWS provides Lambda, S3, API Gateway, DynamoDB and EC2 components; UML provides a class. `createPluginObject` creates versioned structured objects with stable IDs; App inserts them at the current whiteboard viewport or slide location and validates the candidate scene before one undoable commit.

`editor/PluginLibrary.tsx` owns palette presentation only. `editor/PluginInspector.tsx` uses registry-supported motion choices and `objectTargets` for nested parts. Motion is saved on the object, then the ordinary animate cue previews its configured behavior. Selecting a part and previewing a highlight routes its stable target ID through the existing server cue/action/renderer lifecycle. These explicit previews do not require paid model inference. Plugin motion execution and part bounds remain canvas-owned.

AWS service/region metadata can be edited in a compact disclosure. UML attributes/methods use draft textareas and an explicit Apply transaction (up to 20 each); normal updateScene pruning removes remembered cues that no longer reference a valid part. Existing generic object editing, undo, persistence and project export remain authoritative. No executable external plugin code is downloaded; this UI exposes the shipped declarative registry.

UI hooks: `library-math`, `library-cloud`, `library-uml`; `add-plugin-math-matrix`, `add-plugin-math-equation`, `add-plugin-aws-{service}`, `add-plugin-uml-class`; `motion-preset`, `preview-motion`, `object-part`, `highlight-part`; `aws-service`, `uml-attributes`, `uml-methods`, `apply-uml`. Root owns browser acceptance; backend/shared and canvas are implementing the agreed schema/registry/renderer contract in parallel.

## In-place slide / whiteboard switch and Hand tool

The floating scene toolbar now exposes Slide / Whiteboard surface buttons (`surface-slide`, `surface-whiteboard`). This changes the current scene in place, preserving its objects, connections, cues, identity and presentation mode. First conversion initializes a camera and Start area; returning to Slide retains board metadata so switching back restores the camera/areas. Conversion is one undoable project update.

Converting a slide to Whiteboard selects the Hand tool immediately, so dragging anywhere—including over existing content—pans. Whiteboards expose Select / Hand buttons (`tool-select`, `tool-hand`) with accessible pressed states and tooltips. Tool selection is local UI state; selecting another scene resets to Select, preserving the established editing workflow for existing boards. SceneCanvas receives `panTool` and owns pointer capture/navigation. A new blank whiteboard is still available, but is no longer required to explore existing content on an infinite canvas.

Surface/tool controls remain visible on mobile in their own compact floating row. Frontend typecheck passed; root owns in-place conversion, object-preservation and pan browser acceptance.

## Generic narrated presentation playback

`playback/usePresentationPlayback.ts` introduces an XState lifecycle: idle → playing ↔ paused → completed, with cancellation from active states. The runtime accepts shared, bounded `PresentationSequence` steps and validates them against the current scene before starting. It contains no matrix-specific lesson logic. Backend/domain planners own teacher-language interpretation, arithmetic and generated step content; shared `applyPresentationStep` owns insert/update/reveal/camera/context mutation semantics.

Each step has a unique runtime token. Insert/update/reveal/attention/camera steps advance only on the matching renderer completion callback; wait steps use cancellable timers and context updates complete locally. Renderer frames carry pause state. Pausing also freezes local wait/watchdog remaining time. A per-step watchdog (declared/default duration plus seven seconds) cancels with an error when the renderer does not complete; it does not claim successful playback. Stale completion/error callbacks are ignored.

Scene mutation and presentation frame update occur in the same React layout turn, enabling renderer-owned no-flash insert entrances. The canvas owns actual group entrance animations, multiple attention targets, pause/resume and camera interpolation. A successful first applied step reports the original action acknowledgement; whole-sequence completion reports animation completion. UI offers compact pause/resume, skip and cancel controls above the input dock. `presentation-playback` remains in the DOM with `data-state` and `data-step` after completion; control hooks are `playback-pause`, `playback-skip`, `playback-cancel`.

All mutations in one dispatched sequence share one undo snapshot. Manual project edits, undo, scene selection, connection loss and a new typed cue cancel active playback before further changes. A new accepted ordinary visual action also cancels the prior sequence. The microphone stays independently active. Self-generated scene snapshots include `sequenceId`; server accepts them only against prevalidated sequence-prefix snapshots so revision updates do not revoke the current action's acknowledgement eligibility. Shared source signatures reject obsolete generated sequences. No sequence state is resumed across reload/disconnect; committed scene content remains saved.

Frontend typecheck passed after runtime integration. Root owns narrated teacher-flow, cancellation, nine-product and generic non-mathematical sequence browser acceptance. Renderer watchdog/cancellation behavior must be retained when extending this subsystem.

Manual commits additionally run shared `invalidateDerivedResults` on each scene: changed source signatures hide stale derived results/equations, remove cached derivation metadata and invalidate lesson progress. Sequence-owned commits bypass this extra transform so server prefix validation sees exactly the shared step reducer output. Cancellation retains already-applied mutations (one Undo restores the pre-sequence scene); camera playback stops at the persisted target rather than continuing invisibly after cancellation.

Matrix inspector data editing now accepts finite numbers and bounded symbolic cells (up to 300 characters each), using `SceneObjectSchema` before atomic Apply. Empty cells, ragged rows and non-finite numeric literals remain rejected; chart data stays strictly numeric. Symbolic expressions are stored as inert strings for the renderer, not evaluated by browser code. Commas delimit cells and newlines delimit rows.
