# Vizli — Product and Technical Plan

Updated: 11 October 2026 (milestone sections appended chronologically; first authored 8 October 2026)

Status: initial local application implemented and verified on 8 October 2026. The user accepted the selected stack, requested extensive delegation, and asked that design and progress be documented for future agents. See docs/STATUS.md for current implementation evidence and next steps. Performance and exact model endpoints remain to be validated.

## Product vision

Vizli listens to a presenter and creates or controls visual explanations as they speak. It supports teachers, business presenters, e-learning authors, and people brainstorming ideas.

Visuals contain individually addressable parts. A speaker referring to a number can cause a red pointer to appear beside that number. Other cues can highlight a component, reveal a derivation step, or animate a flow through a diagram.

## Confirmed product direction

- Accept prepared presentations, scripts, illustration collections, or an initial idea.
- Support both ordinary narration and explicit spoken commands.
- Allow live drawing and changes during an explanation.
- Support rehearsal: remember scenes, illustrations, objects, and their meaning.
- During a prepared presentation, wait for live speaker cues before highlighting, revealing, or animating. Do not replay rehearsal timestamps automatically.
- Follow changes in the presenter's explanation, including departures from prepared material.
- Let the presenter direct responses to audience questions; Vizli may seek permission before answering or changing content.
- Skip uncertain automatic actions rather than guess.
- Preserve editable parts and provide basic editing. Exact editing scope remains open.

## Primary use cases

| Use case | Example behavior | Main technical challenge |
| --- | --- | --- |
| Marketing presentation | Point to a metric, compare figures, reveal a breakdown on cue | Resolve spoken references to existing objects |
| School mathematics | Reveal derivation steps, highlight terms, illustrate associated concepts | Control progression and preserve mathematical meaning |
| Software brainstorming | Create and revise architecture diagrams, sequence diagrams, and mind maps | Maintain an evolving graph and distinguish proposals from decisions |
| E-learning production | Preserve visuals and speech-linked actions for later editing | Maintain an editable scene and event history |

Mermaid diagrams are in scope for exploration. Import/export and live editing behavior are not yet decided.

## Interaction model

### Prepared presentation

1. Import or assemble content.
2. Rehearse and associate objects with concepts, terminology, and available actions.
3. Review and edit the saved presentation.
4. Present with live speech-driven pointers, highlights, reveals, and animations.
5. Correct, undo, revisit, or request new content during delivery.

Rehearsal memory stores semantic associations rather than requiring exact wording. It does not require model fine-tuning per presenter. Automatic slide advancement and how later rehearsals revise approved content remain open questions.

### Live explanation and brainstorming

1. Begin with a blank scene or an existing diagram.
2. Interpret speech in the context of visible objects and recent discussion.
3. Create or modify structured objects on clear cues.
4. Preserve object identities and an undo history as the scene evolves.

Tentative language such as “we could put a cache here” needs a product decision: show a proposal, commit a change, or wait for an explicit command.

## Proposed architecture

```text
Microphone
    → Streaming speech recognition
    → Recent speech + scene context + relevant rehearsal memory
    → Nemotron interpretation through Nebius Token Factory
    → Validated visual action
    → Browser renderer and editable scene
```

Use two response paths:

- **Attention and playback:** point, highlight, reveal prepared content, or start a defined animation. Keep context and output small.
- **Content changes:** retrieve an illustration, create a diagram, change its structure, or process a rehearsal. Allow more reasoning and preserve revisions.

The model proposes actions against stable object IDs. The renderer computes coordinates and animation frames. Model output must not directly execute arbitrary browser code.

### Example action

Visible object: `revenue_2025`, meaning annual revenue, value `$3 million`.

Spoken phrase: “Revenue reached three million.”

Proposed action: `point_to(object_id="revenue_2025", placement="below")`.

The controller checks that the object exists in the current scene and the reference is sufficiently clear, then the renderer anchors a pointer to it.

### Reliability requirements

- Skip ambiguous references; model-reported confidence alone is insufficient evidence.
- Validate action types, targets, arguments, and current scene state.
- Discard stale responses after scene changes using scene revisions or equivalent checks.
- Deduplicate actions caused by revised partial transcripts.
- Avoid repeated animation triggers from the same utterance.
- Define interruption, completion, and replay behavior for animations.
- Keep temporary attention effects separate from persistent content changes.
- Preserve undo and correction history.
- Decide how presenter identity is established before letting audience speech drive changes.

## Explicit state transitions

User direction, 8 October: use state machine transitions. Implement typed states, events, guards, and effects. The model proposes an event/action; a deterministic transition function decides what may happen. Network and model work execute outside the transition function and return tagged events. The server owns authoritative scene transitions; the browser owns actual rendering and reports its results.

Use independent machines so listening continues while interpreting and animating:

| Machine | Main transitions | Guard or effect |
| --- | --- | --- |
| Connection | DISCONNECTED → CONNECTING → READY; READY → RECONNECTING → READY; any active state → CLOSED | Accepted handshake before upload; fresh connection epoch and snapshot on resume; failed retry budget returns to DISCONNECTED |
| Input | OFF → LISTENING; LISTENING → MUTED → LISTENING; active input → UNAVAILABLE | Microphone permission/device availability; restore listening only when session and device allow it |
| Presentation mode | EDITING ↔ REHEARSING; EDITING/REHEARSING → PRESENTING; PRESENTING → EDITING | Explicit mode event; revisioned save/snapshot; do not infer these transitions from every mention of rehearsal |
| Cue, one per candidate | CANDIDATE → RESOLVING → READY → DISPATCHED → APPLIED | Stable enough speech, valid target, permitted action, matching scene/transcript revision; ambiguity → SKIPPED; obsolete work → INVALIDATED; execution error → FAILED |
| Animation, one per instance | IDLE → RUNNING ↔ PAUSED; RUNNING → COMPLETED; RUNNING/PAUSED → CANCELLED | Valid cue starts playback; explicit pause/resume/cancel; completion comes from renderer; failed renderer → FAILED |

Permission-dependent proposals use RESOLVING → AWAITING_APPROVAL → READY, or → SKIPPED on refusal/expiry. Approval is bound to the proposed action and scene revision; a scene change requires revalidation. Cue readiness is separate from an action actually reaching the display.

Example transitions for a red pointer:

1. `SpeechUpdated` creates a candidate for “three million.”
2. `ResolveRequested` moves it to RESOLVING and starts tagged interpretation.
3. `TargetResolved(revenue_2025)` passes the target/revision/ambiguity guards and moves it to READY.
4. `Dispatch` moves it to DISPATCHED and sends `PointTo` to the renderer.
5. `RenderApplied` moves it to APPLIED; the pointer remains as a temporary effect with its own expiry.
6. `EffectExpired` removes the pointer. `SceneChanged` or a relevant correction can cancel it earlier.

If the transcript changes before dispatch, invalidate the candidate. If it changes after application, issue a compensating clear/correction event; cancelling the original model request cannot retract pixels already displayed. Persistent edits use explicit undo transitions and stored prior values rather than silently rolling back unrelated later work.

Replay determinism applies to recorded events and accepted model results, not to re-running a nondeterministic model. Use XState for state machines and actors, with a single authoritative server session actor and client actors for connection, input, and rendering lifecycles. Shared event schemas do not imply that client and server both own the same authoritative state. Actor mailboxes still need explicit overload controls; actors do not automatically provide durable execution or bounded backpressure.

## Canvas and rendering decision

Recommended initial implementation: **a React-controlled SVG/HTML scene surface, with React Flow for editable graph diagrams**. “Canvas” is the workspace users see; it need not be an HTML `<canvas>` bitmap.

The saved Vizli scene model is the source of truth. Renderers are projections of that model and report measured bounds for stable object/part IDs. Selection, speech targeting, undo, and persistence use those IDs rather than fragile DOM selectors or renderer-specific indices.

| Content | Renderer | Editable/targetable unit |
| --- | --- | --- |
| Slides, charts, illustrations | React components with SVG shapes/paths and HTML text where appropriate | Number, label, bar, connector, named illustration part |
| Architecture diagrams and mind maps | React Flow custom nodes and edges | Component, nested part, connection |
| Sequence diagrams | Dedicated SVG layout from participants and ordered messages | Participant, message, activation, annotation |
| Mathematics | KaTeX for typesetting inside explicit semantic wrappers | Equation, step, deliberately modeled term |
| Pointers and highlights | Shared SVG overlay with measured object anchors | Temporary effect attached to an object or part |
| Animation | Browser Web Animations API for supported properties; explicit frame updates for path-following where needed | Registered, cancellable animation instance |

Layering: scene background → persistent content → temporary attention/animation overlays → editor selection handles. Presenter controls sit outside the audience surface. All renderers share the scene coordinate contract; graph pan/zoom and slide scaling must transform anchors consistently. Update bounds after layout, font loading, resizing, and object movement.

React Flow supplies graph interaction primitives. The general slide surface still requires basic selection, dragging, resizing, text editing, and undo to be implemented; SVG alone is not an editor framework. Scope those controls to the agreed basic editing requirements.

KaTeX typesets mathematics but does not infer pedagogical parts. Store semantic term IDs explicitly and test grouping/bounds before promising arbitrary term highlighting. Supplied equations do not automatically become validated derivations.

Mermaid remains an import/export or preview option. Full editable round-trip support is undecided. Preserve Vizli's own graph IDs and semantics rather than depending on regenerated Mermaid SVG IDs.

Animation descriptors refer to known operations such as `pulse`, `reveal`, `trace_path`, and `move_pointer`. The runtime binds them to scene objects, starts them only on an accepted cue, and reports started/completed/cancelled/failed events. React owns persistent scene state; the animation runtime owns temporary animated properties and cleans them up before a scene update replaces its targets.

This rendering choice suits the initially described slides and diagrams. Benchmark realistic object counts before considering Canvas/WebGL for dense scenes. Raster assets can appear inside the scene, but independently editable internal parts require authored structure or explicit annotated regions.

References checked 8 October 2026: [React Flow custom nodes](https://reactflow.dev/learn/customization/custom-nodes), [Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API), [KaTeX API](https://katex.org/docs/api).

## Proposed project data model

| Entity | Information to retain |
| --- | --- |
| Presentation | Scenes, assets, approved revision, metadata |
| Scene | Layout, objects, relationships, initial visibility |
| Object | Stable ID, type, semantic meaning, aliases, content, geometry, editable properties |
| Illustration asset | Reusable visual elements, named internal parts, supported actions |
| Cue association | Relevant idea or instruction, target objects, available action, trigger policy |
| Rehearsal memory | Transcript, terminology, scene associations, user corrections |
| Live session | Current scene, focus, animation state, pending actions |
| Event history | Speech-linked actions, revisions, undo information |

A flat image or PDF does not automatically provide editable internal parts. Import may require reconstruction or identifiable regions over the original. Fidelity and review requirements must be established before promising arbitrary presentation import.

## Selected technology stack

Decision, 8 October 2026: use TypeScript for the product and managed speech/model inference. This supersedes the earlier Python/Kotlin alternatives and the initial proposal to self-host NVIDIA speech recognition. Reuse Ono's architectural principles in a smaller Vizli-specific runtime.

| Layer | Selection | Rationale or condition |
| --- | --- | --- |
| Frontend | React + TypeScript + Vite | Browser-first presenter controls, audience display, basic editor |
| Slide and illustration rendering | SVG and HTML components | Addressable elements and precise pointer anchors |
| Graph editing and layout | React Flow + ELK.js | Graph interaction plus automatic layout; keep manual positions stable unless a layout change is requested |
| Mathematics | KaTeX | Typesetting inside semantic wrappers; not mathematical validation |
| Animation | Web Animations API + targeted requestAnimationFrame updates | Cue-driven playback, pause, cancellation, and path-following |
| State machines | XState | Explicit guarded transitions and actors on server and client; pin a stable release, not an alpha |
| Backend | Node.js + TypeScript + Fastify + @fastify/websocket | Long-lived streaming sessions with shared frontend/backend contracts |
| Wire and action validation | Zod schemas in a shared TypeScript package | Validate incoming events and model action proposals at runtime |
| Audio capture | Browser getUserMedia + AudioWorklet → PCM over WSS | Stream audio continuously through the session server; sample-rate conversion must match the speech endpoint |
| Speech recognition | NVIDIA-hosted Nemotron ASR Streaming | TLS gRPC through the Railway backend; no self-hosted speech GPU; validate partial/final semantics and domain vocabulary |
| Live interpretation | NVIDIA Nemotron 3 Super on Nebius Token Factory | Selected initial ID `nvidia/nemotron-3-super-120b-a12b`; verify account access and measure action accuracy/latency |
| Preparation | NVIDIA Nemotron 3 Super on Nebius Token Factory | Initially reuse the same model for scene planning; optional planning override remains available |
| Database, authentication, assets | Supabase Postgres + Auth + Storage | Projects, revisions, user access, and illustration assets in one managed service |
| Packaging and deployment | pnpm workspace; Dockerized long-running Node service | Serve the built web app and API together initially; persistent WebSocket process rather than short-lived request functions |
| Verification | Vitest + Playwright | Transition/replay tests and browser microphone/renderer scenarios; later live provider measurements |

The frontend and server share scene definitions, event names, and validation schemas. The browser performs interactive rendering and animation; the Node process owns decisions and I/O. Move expensive import/layout computation into workers if measured workloads block either event loop.

Use structured model outputs or tool calls where supported by the chosen endpoint, followed by application validation. Confirm exact model IDs, account availability, licenses, and capabilities before implementation. Endpoint validation may require changing the chosen Nemotron variant without changing the architecture.

**Updated speech choice:** The user explicitly chose NVIDIA-hosted Nemotron ASR. Use the hosted Riva gRPC API, preserving Vizli's own phrase-level cue detection and partial/final cancellation. NVIDIA/Nebius compliance still comes from meaningful Nemotron runtime calls on Token Factory, not the NVIDIA-hosted speech endpoint alone. The earlier Deepgram choice is superseded.

**Initial operational shape:** one Node instance owns live sessions, with bounded reconnect grace in memory; committed scene revisions and edits live in Postgres. A process restart restores saved presentation state and establishes a fresh live session. Do not claim cross-instance seamless resume until session routing and durable recovery are implemented. Provider keys stay on the server. Use project access policies for stored data and server-authorized scene edits.

Sources checked 8 October: [XState actors](https://stately.ai/docs/actors), [Fastify WebSocket support](https://github.com/fastify/fastify-websocket), [React Flow layout options](https://reactflow.dev/learn/layouting/layouting), [Deepgram Flux](https://developers.deepgram.com/docs/flux/quickstart), [Supabase](https://supabase.com/docs), and [hackathon rules](https://nebiusglobalaihackathon.devpost.com/rules).

Mathematical rendering, derivation validation, sequence layout, and Mermaid interoperability need further investigation. Rendering a supplied derivation and generating a correct derivation are separate capabilities.

## Ono voice streaming review

Reviewed the local `../ono` documentation and implementation on 6 October 2026. This was a source review, not a runtime benchmark or validation run. Ono was not modified.

### What Ono implements

Ono distinguishes the **session state machine** (speech events, generation, interruption) from its conversation modes and UI state. The relevant reference for Vizli is the session runtime, not Ono's coaching journey.

1. **One session orchestrator.** `VoiceSession` coordinates STT, model generation, tools, and TTS behind provider interfaces. Its opt-in ordered output channel carries envelopes and audio together; the legacy path has separate flows.
2. **Typed speech lifecycle events.** The Deepgram adapter emits `StartOfTurn`, `Interim`, `EagerEndOfTurn`, `EndOfTurn`, `TurnResumed`, and `Failed`. Its configured eager/final thresholds are 0.45/0.8, allowing speculation before authoritative confirmation. These values are provider-specific, not settings to copy into NVIDIA ASR.
3. **A pure speculation ledger.** `SpeculativeTurnLedger` associates work with an STT epoch, turn ID, and utterance revision. Eager text launches provisional generation; matching final text confirms it; changed final text invalidates and replaces it. Resumed speech can invalidate a speculative revision even after generation has finished.
4. **Ordered decision batches.** `TurnDecisionCoordinator` processes events through a bounded channel and emits immutable, sequenced actions. It does no vendor or database I/O. `VoiceSession` executes the actions outside that decision loop.
5. **Confirmed tool dispatch.** Provisional tool proposals wait for confirmation. Tool ordinals and commit flags prevent duplicate dispatch/history insertion within the ledger. A cancelled speculative generation can be relaunched when final text confirms the turn, avoiding a session stuck waiting for a result that will never arrive.
6. **Content-aware interruption.** Speech onset alone does not interrupt. Interim text is repeatedly classified so an acknowledgement such as “yeah” can evolve into an interruption such as “yeah, but stop.” Short answers are not suppressed when the session is awaiting them.
7. **Generation is distinct from delivery.** Server generation completion does not mean the user heard the output. `PlaybackLedger` validates client playback reports, sample cursors, generation boundaries, and connection epochs. The client owns stopping its actual playback queue.
8. **Causal protocol metadata.** The v2 protocol carries connection epochs, utterance/generation identities, state revisions, and effect IDs. Logical identity can survive a reconnect while delivery ordering is scoped to one connection epoch.

Simplified speculative lifecycle:

```text
Interim transcript → track candidate intent / prefetch
Eager end         → create revision → start speculative work
Matching final    → confirm revision → release eligible actions once
Changed final     → invalidate old revision → launch replacement
Speech resumes    → invalidate speculative revision → cancel stale output
```

### Adaptation for Vizli

**Vizli needs continuous listening with cue detection inside speech.** Ono is built around conversational turns. A presenter may speak for a minute without yielding the floor while mentioning several objects. Waiting for end-of-turn on every highlight would miss the intended interaction.

Use the same causal principles with cue spans as an additional unit:

| Ono mechanism | Proposed Vizli equivalent |
| --- | --- |
| Utterance revisions | Transcript revisions plus independently tracked cue spans |
| Provisional generation | Resolve candidate objects and prepare a visual action |
| Confirmed tool proposal | Apply a validated action against the current scene revision |
| Generation cancellation | Cancel stale model work and pending visual effects |
| Client playback report | Audience renderer acknowledgement of applied actions and animation lifecycle |
| Connection epoch | Reject output from a replaced connection |
| State revision | Reject effects targeting an obsolete scene or edited object |
| Semantic action IDs | Deduplicate spoken/tapped actions and reconnect retries |

Proposed action lifecycle:

```text
CANDIDATE → VALIDATED → DISPATCHED → APPLIED
     └──→ SKIPPED / INVALIDATED        └──→ COMPLETED / CANCELLED (animation)
```

Do not make listening and animating mutually exclusive states. Keep transport status, transcript/cue progress, scene revisions, and each effect's lifecycle separate. The microphone must remain useful while an animation runs.

Proposed rules:

- Temporary pointers/highlights may act on a sufficiently stable and unambiguous phrase before the whole speaking turn ends. The exact stability policy needs measurement; ambiguous cues still skip.
- Persistent content changes need a completed command or another clearly defined confirmation boundary. A tentative partial transcript must not permanently restructure a diagram.
- New speech does not automatically cancel an animation: presenters naturally narrate over it. Cancellation should follow explicit commands, relevant corrections, scene changes, or invalidation of the cue that caused it.
- Speculatively retrieve library assets or prepare layouts without displaying them until the action is validated.
- Correlate asynchronous work with connection epoch, STT stream epoch, transcript revision, cue ID, scene revision, and action ID as appropriate.
- Check scene/object preconditions again when applying an action, because manual editing can race with model inference.
- Record proposed, applied, and completed actions separately. Browser acknowledgements establish renderer behavior, not proof that an audience member saw or understood the content.
- Restore an authoritative scene snapshot on reconnect. Do not blindly replay old pointers or restart completed animations.
- Coalesce superseded interim text under load; preserve lifecycle events and accepted scene edits. Define overload behavior instead of allowing an unlimited backlog.

### Boundaries and gaps to avoid copying

Ono's own task list says that full session-wide serialization, some durable-write/retraction paths, complete transient-effect origins, STT reconnect epochs, and word-aligned delivery accounting remain unfinished. The narrow speculation coordinator is not evidence that the entire session is already a single serialized actor.

Two concrete implementation details reinforce that caution:

- `VoiceSession` currently supplies a constant `STT_EPOCH = 0L`, despite the ledger supporting epochs and the STT adapter reconnecting. Vizli should increment its STT stream epoch when the recognizer restarts, since provider turn IDs may be reused.
- The STT adapter uses an unlimited event channel, while the decision coordinator and ordered session output use bounded channels. Vizli needs an explicit policy for interim coalescing and critical-event backpressure.

Ono's latency document contains historical measurements that exceeded its target. Reuse the instrumentation approach, not those measurements as predictions for Vizli. Measure audio capture → transcript availability → cue decision → actual visual application, including cancellation and skipped actions.

NVIDIA streaming ASR must not be assumed to provide Deepgram Flux's exact eager/final/resumed event semantics. A provider-neutral adapter may need to derive phrase stability and endpointing from the selected model's outputs.

### Backend decision after this review

Selected on 8 October: **Node.js/TypeScript + Fastify + XState**, as detailed in the selected stack. Ono's ledger, serialized decision boundary, cancellation, and acknowledgement patterns transfer to typed events and actors. This keeps Vizli's scene/action contracts in the same language as its browser editor. No Kotlin service or Python speech service is planned for the initial implementation. Do not copy Ono's coaching-specific `VoiceSession` wholesale or reuse its production services and credentials.

### Local source references

- [Session architecture](../ono/docs/engineering/ARCHITECTURE.md), section 3
- [Wire protocol and lifecycle](../ono/docs/engineering/PROTOCOL.md), sections 3–4
- [Latency measurements and instrumentation](../ono/docs/engineering/PERFORMANCE.md)
- [Known remaining runtime work](../ono/docs/engineering/TASKS.md)
- [VoiceSession](../ono/backend/src/main/kotlin/app/ono/backend/session/VoiceSession.kt)
- [Speech adapter and event contract](../ono/backend/src/main/kotlin/app/ono/backend/stt/DeepgramFluxSttClient.kt)
- [SpeculativeTurnLedger](../ono/backend/src/main/kotlin/app/ono/backend/session/runtime/SpeculativeTurnLedger.kt)
- [TurnDecisionCoordinator](../ono/backend/src/main/kotlin/app/ono/backend/session/runtime/TurnDecisionCoordinator.kt)
- [PlaybackLedger](../ono/backend/src/main/kotlin/app/ono/backend/session/runtime/PlaybackLedger.kt)
- [Client stream and playback handling](../ono/composeApp/src/commonMain/kotlin/app/ono/session/LiveSessionClient.kt)
- [Existing speculation test scenarios](../ono/backend/src/test/kotlin/app/ono/backend/session/runtime/VoiceSessionSpeculationTest.kt) — inspected scenario names; tests not run during this review

## Hackathon alignment

Target: [Nebius x NVIDIA Global AI Hackathon](https://nebiusglobalaihackathon.devpost.com/).

Proposed track: **Best Apps and Agents**. Use Nemotron on Token Factory for the actual interpretation of speech into visual actions.

Rules reviewed on 6 October 2026:

- Use at least one NVIDIA open-source model and run on Nebius Token Factory or Nebius AI Cloud. A runtime Token Factory inference call qualifies; frontend hosting is flexible.
- The proposed track calls for Nemotron through Token Factory. Nebius Serverless deployment is encouraged, not required.
- Submit a working demo, a public repository with an open-source license and setup instructions, a public YouTube demo under three minutes, a project description, and platform feedback.
- Deadline: **30 October 2026, 10:00 a.m. PDT**, equivalent to **31 October 2026, 4:00 a.m. Melbourne time**.
- Keep the project accessible for judging through 15 December 2026.

Source: [Official rules](https://nebiusglobalaihackathon.devpost.com/rules). Recheck before submission. Public release and license choice have not yet been agreed with the user.

Judging considers implementation, design, impact, and originality. The demo should show a coherent presenter workflow with meaningful model use. Source: [Hackathon overview and judging criteria](https://nebiusglobalaihackathon.devpost.com/).

## Proposed hackathon scope — not yet agreed

Lead with a prepared marketing presentation:

1. Open editable scenes and their saved object memory.
2. Speak naturally to highlight a metric and place a pointer.
3. Cue an animation; pause to demonstrate that Vizli waits.
4. Request a comparison outside the rehearsed wording.
5. Correct or undo an action.
6. Briefly demonstrate adding a software component and animating a request path through speech.

The broader vision remains intact. Full-fidelity arbitrary imports, general mathematical reasoning, and broad illustration generation should not be treated as solved dependencies of the first demo.

## Implementation sequence — authorized 8 October

1. Resolve the lead use case, editing boundaries, and deployment budget.
2. Define scene objects, supported actions, and cue behavior using concrete spoken examples.
3. Benchmark streaming transcription and Nemotron reference resolution on those examples.
4. Build one complete path from speech to a validated pointer/highlight on a prepared scene.
5. Add saved projects, rehearsal associations, basic editing, and undo.
6. Add cue-driven animations and one spontaneous diagram-editing example.
7. Evaluate ambiguity, interruptions, stale responses, and transcript revisions.
8. Prepare deployment, open-source repository, documentation, and submission materials.

Measure end-to-end cue-to-display latency, correct target selection, unwanted action rate, missed cues, and correction success. Set acceptance thresholds after initial measurements; no latency guarantee has been established.

## Open questions for continued discovery

1. Which workflow leads the demo: prepared presentations or conversational diagram creation?
2. Is public open-source release acceptable, and which license should apply?
3. Is this a solo build? What time, credits, and GPU budget are available?
4. Does the presenter advance slides, or should Vizli infer slide transitions?
5. Which actions may ordinary narration trigger, and which require explicit commands?
6. Can users teach cue behavior by selecting an object and demonstrating an action during rehearsal?
7. How should a new rehearsal modify an approved presentation?
8. Does basic editing include labels, values, positions, resizing, connections, deletion, and undo? Does it include editing cues and animations?
9. Should mathematics initially illustrate supplied steps or generate and validate new ones?
10. How should tentative brainstorming ideas appear?
11. How does the presenter privately approve responses to audience questions?
12. Which input format must work first, and what import fidelity is acceptable?
13. What languages, accents, and technical vocabulary must the first version support?
14. What should be retained from microphone sessions, and what audio/transcript controls are needed?

Next discovery exercise: write a one-minute example with exact speech and expected screen behavior, including a pause, a correction, and a departure from prepared material.

## Technical references

- [NVIDIA streaming speech recognition](https://docs.nvidia.com/nemo/labs-voice-agent/about/core-concepts/speech-pipeline/speech-recognition/)
- [Nebius Token Factory cookbook](https://github.com/nebius/token-factory-cookbook)
- [Token Factory API reference](https://api.tokenfactory.nebius.com/docs)
- [React Flow custom nodes](https://reactflow.dev/learn/customization/custom-nodes)

These references establish candidate capabilities, not measured performance for Vizli.

## Search and place — 8 October follow-up

User example: **“An apple on the x axis.”** This requires retrieving a real image from the web and placing it spatially, rather than substituting an emoji or generating an invented image URL.

Implementation scope: search Wikimedia Commons over its public API, retain image/source/attribution metadata, and create an editable image anchored to the unique visible chart's x-axis. The Commons search was successfully exercised from the development environment. Search across arbitrary websites and ranking providers can be added behind the same retrieval boundary later. No new API key is required for Commons.

The cue state machine gains an explicit search stage. Persistent insertion waits for a completed utterance; scene changes, newer cues, and cancelled listening invalidate pending results. If no suitable chart exists or multiple charts are possible, explain the missing/ambiguous anchor instead of guessing. This iteration does not infer numeric x coordinates or create a new coordinate plane from this phrase.

Acceptance: typed cue and final speech share the same retrieval pipeline; an actual retrieved image becomes an undoable scene object; moving the chart preserves the axis relationship; manually moving the image detaches that relationship; source metadata survives save/export. Mocked retrieval tests cover deterministic behavior and cancellation; a separate live smoke test verifies the external service.

## Hackathon decisions after product follow-up

The user prioritizes least friction and best results over optimizing for hypothetical scale. The initial choice to retain Deepgram was superseded by the user's explicit request for NVIDIA-hosted Nemotron ASR. Keep the Nebius Nemotron agent. Do not add browser Whisper, a second STT provider, self-hosted speech inference, or paid TTS for this demo. Spoken agent replies are not required for the core speak/transcript/draw workflow. Typed cues remain available; live speech still requires the owner's provider credentials and an actual microphone test.

Keep guest entry with no mandatory login for judges. Implement modest, configurable server-side voice-duration/concurrency and model-request limits. This is a single-instance hackathon safeguard, not persistent per-person accounting or a guaranteed monetary ceiling; reconnects/restarts and multiple replicas must be documented. Provider-side spend controls, where available, remain an additional deployment measure.

User already has Railway and Cloudflare R2. Preferred deployment architecture is Vercel frontend, existing Fastify/WebSocket backend on Railway, Railway PostgreSQL for structured projects when cloud persistence is implemented, and R2 for binary assets. Supabase integration already exists but is optional/unconfigured and is no longer the preferred deployment path. Better Auth remains a later option if account ownership is needed; do not make it a prerequisite for the hackathon demo. None of these hosting/storage choices imply that deployment, Postgres, or R2 integration has already been completed.

Expanded product requirement: provide an effectively infinite whiteboard alongside slides. Whiteboard objects have persistent world coordinates; camera pan/zoom is separate from object movement. “Let's go right” navigates to a new working area; subsequent illustrations appear there, and named areas let the speaker return to earlier content. The milestone below implements this direction with bounded world coordinates, explicit draw commands and named object moves. General contextual references and unrestricted automatic drawing from narration remain beyond the supported cue vocabulary.

## Latest model and eligibility clarification

NVIDIA-hosted Nemotron ASR replaces Deepgram by explicit user instruction. The reasoning model selected in `.env.example` is `nvidia/nemotron-3-super-120b-a12b`, documented by Nebius; both cue and planning paths use it initially. No private credentials/model configuration or successful hosted request exists yet. Nano/Lightning routing and Ultra escalation are optional later choices after live measurements. See `docs/HACKATHON.md` for the requirement mapping: the core Nemotron calls must execute on Nebius Token Factory; NVIDIA-hosted ASR alone is insufficient.

The user explicitly requires keeping the stack aligned with the hackathon. This is now an agent handoff invariant in `AGENTS.md`. The local `pnpm check:hackathon` preflight checks required credential presence, Nemotron model naming and the Token Factory endpoint without making provider calls. Configuration validation is separate from live-provider and submission verification. Existing React/Fastify/XState/graphics choices and planned Vercel/Railway/R2 hosting remain compatible with our reading of the published track; Serverless Endpoints/Jobs are optional rather than mandatory dependencies.

## Whiteboard implementation milestone — completed locally

Continue the authorized build with the user's expanding-whiteboard workflow. Retain existing slide scenes and add an explicit whiteboard layout. Store world coordinates separately from a persisted camera (world top-left plus zoom); keep semantic IDs and image anchors intact. The board is effectively infinite within a generous validated coordinate range, rather than a physically enormous bitmap.

“Let's go right” navigates to an adjacent named area and changes the active drawing location. “Move the apple right” changes the object, not the camera. “Go to Start” revisits remembered content. Pan/zoom by mouse and controls, render only nearby content, and keep selection/highlighting accurate at all scales. New objects and requested illustrations appear in the current area; previous material remains available.

Voice and typed commands share validated actions. Navigation, object movement, and illustration insertion wait for final speech; partial speech may still direct attention. Explicit illustration requests call the existing Nebius scene planner, followed by validated insertion into board coordinates. Without keys the UI must label predefined example templates. Planning is cancellable and revision-fenced.

Agent ownership for this milestone: backend/shared schemas/navigation/planning (backend), viewport/rendering (canvas), studio controls/action integration (workspace), integration/e2e/docs (root). Acceptance includes old project compatibility, camera persistence/reload, object position preservation while panning, movement vs navigation, editable generation at the new location, return-and-highlight, undo, and stale planning cancellation.

Whiteboard acceptance completed: 62 backend tests and 15 browser tests pass; typecheck and production build pass. Added regression coverage for rapid explicit cues, named-area preservation, world-space drag/zoom, stale planning cancellation, cap handling and camera persistence. Visual evidence is in `docs/screenshots/whiteboard.png`. The app remains in demo mode until Nebius/NVIDIA credentials are supplied; hosted speech/model calls and deployment are not claimed verified. Full resumable status is in `docs/STATUS.md`.

Live provider follow-up: Nebius and NVIDIA keys are now configured privately. Verified live scene generation, live cue interpretation, and hosted synthetic PCM → NVIDIA transcript → Nebius highlight action. The local hackathon configuration preflight passes. Natural browser microphone testing and deployment remain outstanding; see `docs/STATUS.md` for evidence and limits.

## Voice amendments — implemented and verified locally

User clarified that editing and amending existing objects through speech is a central product requirement. The prior unsupported-matrix-resize guard is a temporary gap to remove, not a product decision. Add a constrained `edit_object` action interpreted by Nemotron, validated against the current scene, then applied atomically with stable object IDs and one undo entry. First scope: matrix dimensions and cell values, text/metric values and labels, object size and basic appearance. Preserve overlapping matrix cells and fill newly introduced cells with zero; reject ambiguous/invalid targets and unsupported mathematical computation. Persistent edits wait for final speech and retain revision cancellation. Root owns acceptance/docs, backend shared contracts/resolution, workspace App integration, canvas rendering review.

Voice amendments acceptance: 76 backend tests and four targeted browser tests pass, workspace typecheck and production build pass. Hosted continuous speech verified matrix resize followed by cell amendment with zero errors; separate live Nemotron metric amendment passed. Larger matrices now scale typography within their existing object bounds. See STATUS for grounding, latency and symbolic-math limitations.

## Full-screen canvas workspace — 9 October 2026, completed locally

User requested a full-screen canvas with floating action menus and minimal branding at the top left. Replace the dashboard-like shell, permanent branding rail, prominent headings and sidebars with a viewport-filling editing surface. Keep scene selection, file/generation controls, mode changes and inspector in compact floating controls or on-demand panels. Voice/transcript and optional typing remain immediately accessible in a bottom dock. Whiteboards fill the viewport; slide content preserves its authored aspect ratio and fits within it. Existing project data, provider integrations, undo and state machine semantics remain intact.

Ownership: workspace agent App/styles; canvas agent viewport geometry; backend agent browser regression adaptations with isolated demo backend; root visual acceptance and handoff. Acceptance includes desktop/mobile viewport containment, usable menus/inspector, mic/typed access, scene navigation, editing/undo and camera/target geometry.

Acceptance completed: 18 isolated demo browser tests, 76 backend tests, typecheck and production build pass. Desktop/mobile visual review and canvas geometry checks passed. Module handoff documentation is updated; no active ownership remains.

## Domain plugins and motion — 10 October 2026, completed locally

User requested plugin segregation before expanding domain features: maths symbols/matrices, AWS components, UML internal parts and optional draw/write motion. Introduce a shared versioned semantic registry, browser renderer registry and independent cancellable motion adapters. Keep camera/editor/state machines outside plugins and preserve existing projects/targets. Initial vertical slices are matrix/equation, representative AWS service shapes and UML class compartments/members. Architecture, boundaries and extension pattern are recorded in docs/PLUGINS.md.

Ownership: backend agent shared schemas/registry/resolver/tests; canvas agent renderer/motion modules; workspace agent library/editor controls; root integration, browser tests and durable design/status docs. No deployment or provider changes.

Plugin acceptance: shared registry/schema, all object renderers, semantic DOM targets, independent motion adapters and compact library/inspector implemented. Full20browser tests and81backend tests pass; typecheck/build pass. See docs/PLUGINS.md and docs/STATUS.md for concrete boundaries and extension guidance.

## Canvas panning discoverability — 10 October 2026

User could not drag the canvas and perceived a finite surface. Current preview was a slide; whiteboard creation was hidden in scene navigation. Add an explicit Slide/Whiteboard surface switch for the current scene, preserving objects, connections and cues. Entering whiteboard enables a Hand tool so dragging over objects pans; Select restores object editing. Preserve Space/middle-drag and background/wheel navigation. Verify travel beyond the original page, camera persistence, object immutability during pan and return to slides without data loss. Canvas world remains sparse coordinates with culling, not a giant bitmap.

Canvas panning acceptance: 4 targeted browser tests passed, including slide conversion and panning beyond3000worldunits without changing objects. Current user preview switched to Whiteboard/Hand and verified by CUA.

## Narrated lesson orchestration — 10 October 2026, completed locally

Implement user's six-step teacher demonstration as a domain-planned presentation sequence, reusable outside maths. Shared validated commands, browser playback controller, render/motion attention, and domain-specific arithmetic stay separate. Matrices introduced by dimensions use symbolic entries; numeric source matrices yield verified numeric dot products. Preserve speech concurrency, final-only mutation, semantic targets, smooth motion, cancellation/revision fences, undo and editable persisted results. See docs/NARRATED_LESSONS.md for acceptance and design.

Ownership: backend/shared domain planner+contract; workspace sequence runtime/App integration; canvas attention/entrance/camera; root cross-layer verification/docs/live smoke. No deployment or provider change.

Narrated lesson acceptance: 23 browser tests, 89 server tests, typecheck and build passed. Six hosted NVIDIA ASR clips produced six valid sequences with zero errors. Playback reuse was also verified with AWS objects. Symbolic/numeric maths, partial-speech guards, stale-output invalidation, colours, animation, camera motion and cancel/undo are documented in NARRATED_LESSONS.md.
