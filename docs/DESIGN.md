# Vizli implementation design

Status: full-screen workspace implemented, 9 October 2026. See STATUS.md for verification and explicit product boundaries.

## Product experience
A presentation studio where the speaker controls attention with their voice. The application opens directly into an editable deck, with three useful examples: marketing metrics/charts, a mathematical matrix, and a software architecture. The canvas fills the window behind floating controls. A small top-left brand/project control opens the scene filmstrip; project actions and presentation modes float above the canvas. Object properties and activity open on demand. A bottom dock keeps microphone, typed cues and live transcript accessible. Slides fit and center at their authored aspect ratio; whiteboards use the complete viewport without changing stored world coordinates when resized.

Edit, Rehearse, and Present are explicit modes. Rehearsal binds a phrase to an object/action. Presentation preserves prepared material and waits for live cues. A deterministic demo lets someone explore the app without API keys, clearly distinguished from live AI.

## Visual direction
Evergreen accents, ivory background, readable editorial canvas typography, restrained borders and shadows. The canvas is the main visual focus. Selection chrome is confined to editing. Pointer/highlight effects use a conspicuous red or warm contrasting accent; they should direct attention without permanently changing content styling.

## System boundaries
- React/Vite browser: local selection and editor interactions, microphone capture, SVG/HTML/React Flow rendering, actual animation lifecycle.
- Node/Fastify: provider credentials, WebSocket session, XState cue decision lifecycle, validation and persistence.
- Shared package: Zod schemas, project/scene/action types, demo content.
- External services: NVIDIA-hosted Nemotron ASR and Nemotron reasoning on Nebius Token Factory. Supabase email-link Auth and owner-scoped project snapshot storage are implemented as optional cloud features; local persistence works independently. Separate asset uploads are deferred.

### Hackathon operating choice

Use NVIDIA-hosted Nemotron ASR streaming and Nebius Token Factory reasoning, as explicitly selected by the user. No paid TTS, alternate speech provider, or mandatory login is required for the demo. Lightweight server limits cap simultaneous voice/model operations, cumulative microphone time per WebSocket, and model attempts per rolling hour. Limit checks precede provider calls; timers and disconnects release voice capacity and close upstream streams. Model calls release concurrency in `finally`, including failures. Counters are in-process and intentionally not described as durable accounting or a monetary guarantee.

The preferred deployment direction is now Vercel frontend + Railway backend/Postgres + R2 assets, reflecting services the user already has. These integrations are pending. The optional Supabase implementation remains available but is not the chosen dependency for deployment. Public project ownership/isolation still needs implementation; server limits do not provide authorization.

## State and causality
A scene revision accompanies every cue/action. Asynchronous work must be discarded if its scene/revision is obsolete. Model output is a proposal and cannot execute arbitrary code. The server verifies targets and supported operations. Client acknowledges actual application separately from generation completion.

Continuous speech updates can create phrase-level cues; do not wait only for end-of-turn. Coalesce superseded requests and bound processing. Temporary effects expire, relevant corrections clear them, and scene changes clear all obsolete transient state.

## Rendering
Logical coordinate system 1200 × 675. Scene objects have stable semantic IDs. Matrix rows/cells and chart bars have deterministic nested IDs, so individual parts can be targeted. SVG/HTML handles slide objects; React Flow handles graph interactions. Images are positioned scene objects. Never infer editable anatomy from a raster image.

Whiteboards use that same logical viewport over world coordinates, bounded to ±1,000,000. The persisted camera `{x,y,zoom}` is separate from object geometry. The renderer transforms and culls world objects; SVG connections share the camera instead of nesting React Flow's camera. XState navigation transitions between idle, panning and navigating; gesture completion commits one undoable camera update. Named areas supply stable return destinations, while adjacent regions are 1,320 × 795 world units apart.

Final navigation cues change the camera; explicit move cues change one unambiguous object. Final draw/illustrate cues enter an abortable planning state and generate validated editable objects using the existing Nebius planner. The shared append helper remaps IDs/connections/anchors and chooses a free region, preserving earlier content. A prepositioned action payload is merged once by the client. Revisions cancel stale planning; camera-only updates can preserve an already-dispatched renderer acknowledgement. Boards retain the 300-object limit, so expansion is spatial rather than unlimited storage.

The structured project is the source of truth. Imported project JSON is validated. Persistent edits enter undo history; highlighting is transient. Mathematical rendering is not symbolic correctness validation.

### Retrieved images and spatial intent

“An apple on the x axis” separates into image subject and spatial anchor. The interpreter proposes a search query; the retrieval service supplies a real image URL and provenance. Model output must never invent asset URLs. Initial retrieval uses Wikimedia Commons, not an unrestricted web index.

An image stores its source page, search query, provider and available attribution/license. Its optional x-axis anchor references a stable chart ID. Shared geometry resolves its position from the current chart bounds and baseline. Chart movement/resizing preserves the relationship; dragging the image explicitly detaches it. A unique visible chart is required; missing/ambiguous anchors produce a clarification message without a search or insertion.

Image retrieval is an abortable state between cue interpretation and dispatch. Only final speech can create an image. Retrieved results are subject to the same scene/revision fencing and renderer acknowledgements as other operations, and insertion is undoable. External image failures remain visible rather than silently substituted with fake results.

## Implementation interfaces
See BUILD_CONTRACT.md for props, event envelopes, and ownership. Document deviations there and in the relevant module handoff before integrating.

## Testing strategy
Prioritize transition/validation tests and browser journeys: cue → visible effect, stale cue cancellation, scene changes, edit/undo, save/reload, project import/export, rehearsal binding, and honest microphone/provider state. Evaluate rendered desktop and narrow layouts. Record unavailable external verification explicitly.

## As-built additions

CreateScene sends an idea to the validated scene-generation endpoint. Without model configuration the endpoint returns an explicitly identified example template. CloudSync implements optional explicit save/load rather than mixing cloud writes into local autosave. Renderer selection is independent of edit permission so rehearsal can bind objects while keeping geometry stable. Matrix/chart data editing validates the complete dataset before one undoable commit. See module docs for transition guards and known limitations.

## Spoken object amendments

Voice edits are a core interaction, not limited to pointing at prepared content. `edit_object` carries an existing `targetId` and a small typed `patch`; it never runs arbitrary code or accepts an unrestricted JSON mutation. Shared `applyObjectEdit` validates object-kind compatibility, dimensions, cell/category indices and the resulting scene before returning a new scene. The client commits that result once, preserving stable IDs and one-step undo. Partial transcripts cannot commit persistent edits; asynchronous results retain revision fencing.

Matrix resizing preserves cells in the overlapping rectangle and zero-fills new cells. Cell coordinates are one-based in speech and zero-based on the wire. Other amendments include text, labels, metric values, dimensions, colors and chart data values. Ambiguous targets must be skipped, rather than guessed. Authored mathematical explanations remain static; editing a matrix does not automatically recompute a symbolic derivation.

## Domain plugin separation — 10 October 2026

All object rendering now goes through a trusted renderer registry. Shared versioned plugin contracts define valid persisted data, compatible kinds, semantic targets and available motion. Domain modules supply maths, AWS and UML representations; generic objects retain their existing kinds and IDs. Motion adapters operate on declarative DOM markers and remain independent of object data. Canvas host, editor history and voice state machines keep their current responsibilities. See [PLUGINS.md](PLUGINS.md) for the layer diagram, file map and extension checklist.

## Narrated sequences

DomainPlanner modules compile grounded instructions into a validated PresentationSequence. Shared step reducers separate semantic mutations from browser playback; the XState player orders renderer acknowledgements and supports interruption, pause and grouped undo. Source signatures prevent stale derived results; validated sequence self-commits preserve revision fences. See [NARRATED_LESSONS.md](NARRATED_LESSONS.md) for contracts and the complete teacher demonstration.

The AWS request-flow planner is a bounded, deterministic addition: finalized meeting clauses append only the newly grounded stage, retaining stable object/edge identity and unrelated scene content. During playback, subsequent clauses queue and plan against the latest acknowledged scene. Real cancellation, manual edits, undo and scene changes invalidate pending work; a later clause must still be accepted after cancellation/re-entry. The Route 53 annotation describes configured DNS routing policy and health/latency signals as best effort. The diagram distinguishes application writes to a PostgreSQL primary, application reads from the replica group, and replication from writer to replicas. Official AWS SVG assets are bundled locally with source provenance. Known phrase patterns do not constitute general architecture inference, live infrastructure inspection, or microphone/model verification.
