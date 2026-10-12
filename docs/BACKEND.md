# Backend and shared scene implementation

Updated: 11 October 2026 (chronological sections below; first authored 8 October 2026). Owner: backend implementation agent. Implementation is authorized. This document describes shipped code, not the broader product wishlist.

## What exists

- `packages/shared/src/index.ts`: strict Zod schemas and inferred TypeScript contracts; three editable demo scenes; stable nested matrix row/cell/column and chart bar targets.
- `apps/server/src/app.ts`: Fastify HTTP/WS application factory, request origin restrictions, security headers and CSP, project API, static production frontend serving. Local binding is the default. There are no accounts: project ids are read capabilities and edit tokens are write capabilities (`docs/SECURITY.md`, 12 October 2026), with per-client limits and an admin delete route.
- `session.ts`: XState session and cue actors, cancellation, revision gates, bounded latest-partial transcript processing, duplicate suppression, renderer acknowledgements, bounded actor history.
- `resolver.ts`: deterministic explicitly labeled demo resolver and actual Nebius chat-completions adapter. Live mode requires BOTH `NEBIUS_API_KEY` and `NEBIUS_MODEL`, avoiding an assumed model catalog entry. Failed inference reports an error; it does not silently masquerade demo output as live inference.
- `speech.ts`: NVIDIA hosted Nemotron ASR via Riva bidirectional gRPC with TLS, PCM16 mono 16kHz audio, bounded startup/upload buffering, and portion-final/partial transcript handling. This replaces Deepgram. Keys stay server-side.
- `store.ts`: traversal-resistant, atomically replaced per-project files: `<id>.yjs` (authoritative Yjs document state), `<id>.json` (derived, schema-valid plain copy) and `<id>.access.json` (SHA-256 of the edit token). Invalid existing files are preserved and reported, not silently overwritten; `deleteProject` removes all three.
- `collab/rooms.ts`, `collab/limits.ts`, `collab/access.ts`: one Yjs `DocRoom` per project (sync/awareness relay, role enforcement, document size cap, debounced persistence, idle eviction), the `RoomRegistry` (roles, creation with hashed edit tokens, authorisation for HTTP, deletion), per-process and per-client limits, and token minting/hashing. See "Collaborative rooms" below and `docs/SECURITY.md`.

## Run and configure

Run workspace installation/build/dev from repository root per README. Server scripts: `pnpm --filter @vizli/server dev`, `test`, `typecheck`, `start`. Root `.env` loads even when pnpm launches from the server package. Build currently typechecks source; runtime uses `tsx`. Shared package exports TypeScript source.

| Environment | Default / requirement |
| --- | --- |
| `HOST` | `127.0.0.1`; do not expose unauthenticated local API publicly |
| `PORT` | `3001`; the Vite dev proxy reads the same root `.env` value, so changing it moves the whole local stack |
| `DATA_DIR` | repository `.data`; relative overrides resolve from process working directory |
| `NEBIUS_API_KEY` | optional server-only secret |
| `NEBIUS_MODEL` | required alongside key; exact account-available model ID |
| `NEBIUS_BASE_URL` | `https://api.tokenfactory.nebius.com/v1` |
| `NVIDIA_API_KEY` | required for hosted microphone transcription |
| `NVIDIA_ASR_ENDPOINT` | `grpc.nvcf.nvidia.com:443`; hostname:port, TLS always |
| `NVIDIA_ASR_FUNCTION_ID` | `bb0837de-8c7b-481f-9ec8-ef5663e9c1fa` |
| `NVIDIA_ASR_LANGUAGE_CODE` | `en-US` |
| `ALLOWED_ORIGINS` | localhost and 127.0.0.1 on port 5173 and the configured `PORT`; comma-separated override |

Server serves `apps/web/dist` if built. HTTP calls with a disallowed Origin and cross-site mutation requests are rejected. No wildcard CORS. These protections are NOT authentication; add identity and authorization before remote hosting.

## Causal behavior

A cue transitions `candidate → resolving → ready → dispatched → applied`. Applied only occurs on a matching browser acknowledgement; animation completion transitions to completed. Skip, invalidation, and failure are terminal outcomes. Session transitions awaiting_scene → ready → closed.

Scene changes and revisions abort interpretation and invalidate outstanding actors. A revised interim transcript (11 October 2026) retracts only actions dispatched from partials of the current utterance and emits `clear` with `scope:"effects"` only when such speculative effects exist; dispatched finals, sequence snapshots and their acknowledgements survive. Empty final boundaries reset speculative state without a cue. `stopSpeech` cancels speech-originated interpretation only, so a typed cue survives microphone toggles. Equal revision with different scene content is rejected. New interpretation supersedes pending interpretation; it does not cancel an already dispatched animation solely because speech continues. Model fetch timeout is 12 seconds. Partials are coalesced into a latest-text slot with a 320ms bounded throttle, allowing progress during continuous narration. Only one partial interpretation runs at a time; its completion schedules the newest queued partial. Final speech can supersede that work; permanent add/undo/reveal wait for final speech. Temporary point/highlight/animate can dispatch before turn end. Speech dedupe lasts through the turn, then resets, allowing the same target in a later turn. A changed transcript prefix clears speculative emphasis and permits a corrected target. This heuristic needs recorded speech evaluation before production claims.

Persistent scene state lives in the server-side Yjs room for the project (12 October 2026); browsers edit their local Y.Doc and sync through the session socket, and the voice session reads the room's repaired plain project. A presenter's own commits (`onPlain('self')`) keep the abort semantics above; peer commits never abort interpretation and only prune actions whose targets vanished. The room's update counter is stamped into each action as `revision`. There is no cross-process room sharing or session recovery.

## Collaborative rooms

Updated 12 October 2026. Single process, in memory, no authentication: anyone who can reach the socket and passes the Origin check can join any project ID.

- **Socket framing** on `/api/session`: JSON text frames carry `ClientMessage`/`ServerMessage`. Binary frames are `varuint channel` + body: `0` Yjs sync (y-protocols sync messages), `1` awareness (`varUint8Array` of an awareness update), `2` PCM16 microphone audio (previously unprefixed). Binary frames before `joined` are dropped silently.
- **Join**: the first JSON message must be `join{projectId,userId,clientId,name,color,sceneId?,seed?,token?}`; anything else gets `error{code:'not-joined'}` (including `listen`), and a second join gets `already-joined`. The registry loads `<id>.yjs`, else migrates `<id>.json`, else uses a valid `seed` with the same ID, else the demo project for `default`, else `error{code:'project-not-found'}`. Other `RoomError` codes (`rooms-full`, `room-full`, `project-unreadable`, `invalid-seed`, `project-limit`) are reported as `error{code}`; unexpected failures as `join-failed`. Message order on success: server sync step 1 (binary, sent inside `room.join`), then `joined{projectId,docId,version}`, then the session's `state:'ready'`. The client should send its own step 1 after `joined`. If the socket closes during the asynchronous load, the member leaves immediately. `view{sceneId}` changes the scene the session interprets against. `token` is accepted by the schema but not checked.
- **Effects**: `action` messages go to the originating socket. `highlight`, `point`, `animate` and `clear` are additionally sent to every other room member as `effect{action,clientId,name}`; `navigate` and persistent actions are not. Transcripts, state and skips stay private to the speaker.
- **Persistence**: room updates are debounced (`COLLAB_SAVE_DEBOUNCE_MS` 1000, max wait `COLLAB_SAVE_MAX_WAIT_MS` 5000) and write `<id>.yjs` and then `<id>.json`; rooms flush on eviction (`COLLAB_ROOM_IDLE_MS` 60000 after the last member leaves) and on server shutdown (`preClose` → `registry.closeAll()`).
- **HTTP**: `GET /api/projects/:id` returns the live room's plain project, else the stored document, else the plain file; unknown IDs 404 except `default`, which returns the demo project. `POST /api/projects {project?, template?:'demo'}` creates `p-<16 hex>` (ID rewritten; demo template by default) and returns 201 `{id}`; 429 when `MAX_PROJECTS_CREATED_PER_HOUR` is exceeded. `PUT /api/projects/:id` validates as before and imports by diffing into the live room (members converge) or the stored document, returning `{ok:true, mode:'room'|'document'|'created'}`. `/api/status` adds `collab:{rooms}`.
- **Abuse bounds** (env, nonnegative integers): `MAX_ROOMS` 100, `MAX_ROOM_SOCKETS` 8, `MAX_PROJECTS_CREATED_PER_HOUR` 200, `COLLAB_SYNC_MAX_MESSAGE_BYTES` 10 MB (larger sync frame → close 1009), `COLLAB_SYNC_BYTES_PER_SECOND` 2 MB with a one-message burst (exceeded → close 1008), `COLLAB_AWARENESS_PER_SECOND` 30 (excess dropped), `COLLAB_MAX_BUFFERED_BYTES` 16 MB (slow reader → close 1013; also applies to pre-join JSON). Unreadable frames or unknown channels send `error{code:'bad-frame'}`; the fifth closes with 1007. Origin allowlist, usage guards, voice budgets and cue bursts are unchanged.

Verification (12 October 2026): `pnpm --filter @vizli/server test` 200 tests in 20 files passed; shared and server typechecks passed. `app.test.ts` covers two real `ws` clients syncing an edit, HTTP read-through, `.json`/`.yjs` written on close, join ordering errors, effect fan-out without transcript leakage, HTTP import convergence, 1009/1007 closes, awareness flood dropping and project creation. Browser clients and Playwright were not run against this server change.

## Validation and known limitations

- JSON shape, allowed action types, current target IDs, matrix bounds, explicit mutation verbs, negation/tentative cues, basic grounding evidence and stale scene revisions are checked.
- Model-provided evidence is only an additional grounding check, not a calibrated ambiguity detector. Live recognition/model behavior has not been measured without credentials.
- Demo understands object labels/aliases, rehearsal phrases, matrix ordinal rows/columns and numeric cells, chart category labels, and explicit add-node commands. It is deliberately not general natural-language understanding.
- Hosted NVIDIA audio and Nebius model calls have not been validated against a paid account. NVIDIA protocol and metadata were checked against the official hosted model API and pinned Riva schemas; local gRPC protocol tests pass.
- No raw audio is persisted. Saved project JSON persists locally; transcripts are session/browser UI state.
- No Supabase integration, accounts, access policies, PDF/PPT reconstruction, mathematical correctness engine, library retrieval service, or durable action replay yet.
- Rehearsal cue text is matched literally in demo; live model gets relevant saved associations as context.
- The backend is a local prototype. Origin checks alone do not secure an externally bound service.

## Verification

Run `pnpm --filter @vizli/server test` and `pnpm --filter @vizli/server typecheck`.

17 tests passed at the current handoff: nested matrix row validation, chart bars, ambiguity, tentative changes, invalid graph links, render ack semantics, stale result cancellation, partial/final dedupe, independent repeated speech turns, final-only persistent mutation, continuous interim progress, malformed WebSocket messages, unavailable microphone state, model unknown targets/missing evidence/unsupported fields, provider HTTP failures, conflicting rehearsal cues, and HTTP validation/persistence/origin rejection. Some scenarios are grouped within single test cases.

Next priorities: use actual provider credentials to benchmark speech-to-render latency and semantic accuracy; recorded NVIDIA Riva partial/final revision fixtures; stronger turn/span identities; private presenter permissions for audience questions; durable authenticated Supabase project storage; action history and explicit pause/resume protocol.

## Primary references

- [NVIDIA hosted Nemotron ASR API](https://build.nvidia.com/nvidia/nemotron-asr-streaming/api)
- [Pinned NVIDIA Riva ASR protocol](https://github.com/nvidia-riva/common/blob/268890b7286031a6d4950e34f7ce13ed0d4ce621/riva/proto/riva_asr.proto)
- [Nebius API reference](https://api.tokenfactory.nebius.com/docs)

## Scene creation from an idea

`POST /api/scenes/generate` accepts strict `{prompt:string,kind:'slide'|'math'|'architecture'}`; prompt is trimmed, required and at most 4,000 characters. It returns `{scene,source:'demo'|'live'}`. This is separate from live WebSocket decisions and does not save or replace the current project.

Live planning uses optional `NEBIUS_PLANNING_MODEL`, falling back to `NEBIUS_MODEL`, plus `NEBIUS_API_KEY`. Requests time out after 25 seconds. Structured model output is validated against strict SceneSchema plus limits of 30 objects/50 connections, positive geometry entirely within x=20..1180/y=190..620, correct requested scene kind, visible content and no invented image assets. Invalid output returns a recoverable 502. Model strings remain renderer text/math data, never executable code. Generated identities are replaced to avoid project collisions.

Without configured model credentials this endpoint returns a freshly identified predefined scene matching the requested kind, with `source:'demo'`. It does not pretend to interpret the idea semantically. Frontend must label this honestly as a template.

Added four tests for demo source/fresh identities, configured planning-model selection and live schema, content bounds/count limits, invalid HTTP body and rejected model output. Total backend tests: 21.

## Final lifecycle review

The backend now scopes recognizer callbacks to a monotonically increasing per-WebSocket speech epoch. Restarting/stopping listening or closing the client connection invalidates old provider callbacks. The NVIDIA adapter ignores callbacks after close. It deliberately does not assume provider turn IDs or monotonic audio_processed result identities. Unexpected provider failure or close calls session.stopSpeech, cancelling queued partials and outstanding interpretation.

Dedupe sets are captured per utterance so completion of an older asynchronous final cannot clear the next utterance's fingerprints. Final speech supersedes outstanding partial interpretation. Cancellation and timeout use an explicit promise race, so even a misbehaving adapter that ignores AbortSignal cannot leave a cue actor resolving indefinitely. Stopped interpretation actors receive invalidated; genuine timeouts receive failed. New sockets own fresh sessions and action maps, so old renderer acknowledgements cannot acknowledge a new action. Stale scene revisions remain rejected.

No provider authorization headers or environment keys are included in application log calls. Speech transport errors are replaced with generic diagnostic messages. Scene-planning failures log validation/error messages but not the HTTP request headers/body or credentials. Local project API access is still unauthenticated; Origin restrictions do not make external hosting safe. Supabase browser integration, if configured separately, does not retroactively authenticate the local API.

Earlier lifecycle verification passed 25 tests. Current NVIDIA adapter verification is listed below; the retired Deepgram ordering tests were replaced with Riva protocol tests. Cancellation of queued speech and timeout of an adapter ignoring abort remain covered. Shared/server typechecks pass. Real provider end-to-end latency remains unmeasured.

## Real web images on chart axes

Implemented the direct utterance **“An apple on the x axis”** and explicit variants such as “Add an image of an apple on the x-axis”. This route is parsed before add-node commands in both demo and configured live interpretation. It yields a bounded search query and existing chart ID, never a model-invented URL. Exactly one visible chart is required; missing/multiple charts result in clarification without a network lookup. Tentative instructions skip.

`images.ts` performs real Wikimedia Commons API search with no credentials: file namespace, bitmap restriction, four candidates, 600px thumbnail request, and selected attribution/license metadata. Only HTTPS images on `thumb.wikimedia.org` or `upload.wikimedia.org` and source pages on `commons.wikimedia.org` are accepted. Returned HTML metadata is reduced to bounded plain text. Apple is expanded to “apple fruit” to distinguish the object from the company. Search has an 8-second timeout plus session cancellation. There is no fabricated image fallback; empty results skip and provider failures report an error.

Permanent retrieval waits for final speech. The cue transitions `resolving → searching → ready → dispatched → applied`. Search results are fenced by the same generation/revision and abort checks as model interpretation, preventing stale image insertion after a scene edit/change. No search starts on interim speech.

Shared contract additions:

- `SceneObject.anchor?: {targetId,kind:'x-axis'}`
- `SceneObject.imageSource?: {query,pageUrl,provider,attribution?,license?}`
- `VisualAction.type: 'add_image'` with optional `object: SceneObject`
- `resolveImageAnchor(object,scene): SceneObject`

Image objects start at 100×100 and attach at chart center, with their bottom on the x axis. The helper derives y from chart top +44+22+baseline, with plotHeight=max(40,height−100) and baseline=plotHeight/2 when any value is negative, otherwise plotHeight. It recalculates position as the chart moves/resizes. Scene validation requires anchors only on images, targeting an existing chart (no self links); hidden charts remain valid saved targets. Frontend detaches dependent images at their resolved positions before deleting the chart and detaches manual image drags.

The source and license metadata must remain visible in the editor and preserved on JSON export. Images remain external resources; no caching or offline asset embedding is implemented. A network request is real even while the broader application is labeled demo, because that label describes model interpretation. No LLM key is required for this deterministic image command.

Verification: actual Commons lookup returned the Red Apple photograph, Abhijit Tembhekar attribution, and CC BY 2.0 metadata. Root confirmed actual browser image pixels and axis attachment separately. **32 backend tests pass**, including phrase parsing, final-only retrieval, stale-result cancellation, missing/multiple charts, safe URL/attribution parsing, geometry changes, and schema anchor integrity. Shared/server typechecks pass.

Reference: [MediaWiki Imageinfo API](https://www.mediawiki.org/wiki/API:Imageinfo).

## Hackathon usage guardrails

The initial guardrails shipped with Deepgram; the user subsequently selected NVIDIA hosted Nemotron ASR for speech. Nemotron through Nebius remains the interpretation and planning provider. `usage.ts` adds a shared, in-process guard to the existing single Fastify application. No authentication service, database, or dependency was added.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `MAX_CONCURRENT_VOICE_SESSIONS` | `5` | Global concurrent upstream speech connections |
| `MAX_VOICE_SECONDS_PER_SESSION` | `600` | Cumulative upstream connection time and PCM audio duration per browser WebSocket, preserved across microphone toggles |
| `MAX_LLM_REQUESTS_PER_HOUR` | `1200` | Global rolling-hour paid model attempts across live cues (including speech) and scene planning |
| `MAX_CONCURRENT_LLM_REQUESTS` | `3` | Global concurrent paid model calls |

Nonnegative integer configuration is accepted; zero disallows the corresponding activity. Failed paid requests count toward the hourly budget. Capacity is acquired immediately before actual provider invocation, so deterministic image commands, local demo actions and demo scene templates do not consume LLM attempts. Concurrency slots release in finally, including HTTP/provider/schema failures. Planning returns HTTP429 when capped; session cues report a readable busy/limit error.

Each socket retains its VoiceBudget across microphone toggles. An expiry timer stops the upstream stream and session interpretation even if the browser sends no audio. Explicit stop, provider error/close, client disconnect, and server preClose cleanup release voice slots and cancel pending speech. The speech adapter’s close is idempotent. An audio token bucket allows a two-second burst and 10% real-time scheduling tolerance at PCM16 mono 16kHz; excessive upload stops the stream. Cumulative audio bytes also cannot exceed the session duration allowance. This prevents flooding large audio volumes within a short wall-clock connection.

Model scene context excludes all image src payloads and source metadata while preserving object ID, label, geometry and anchor. Uploaded base64 images are never copied into the text-model prompt.

These are single-instance, in-memory request/time limits. Counters reset on restart; a new browser WebSocket receives a new per-session voice allowance. They are not user quotas, spend/billing guarantees, persistent abuse prevention, authentication, or distributed limits. They supplement rather than replace provider-side budgets.

Verification: **41 backend tests pass** and server typecheck passes. New tests cover rolling-hour reset, concurrent release/idempotence, failed paid attempt accounting across both providers paths, cumulative voice time across toggles, upload rate enforcement, provider failure/disconnect cleanup using a real local WebSocket, server shutdown cleanup, HTTP429 without provider invocation, and absence of image/base64 content in model request payloads. Live paid provider usage is still unmeasured without credentials.


## NVIDIA hosted Nemotron ASR migration — current speech path

The user explicitly selected NVIDIA hosted speech. Deepgram code and environment variables are removed from the active backend. The browser audio/WebSocket contract and existing usage budgets are unchanged. `NvidiaSpeech` connects using TLS to `grpc.nvcf.nvidia.com:443`, with server-only `authorization: Bearer NVIDIA_API_KEY` and `function-id` metadata. The default function ID comes from NVIDIA’s hosted nemotron-asr-streaming API documentation. This runs on NVIDIA’s hosted API, not a self-operated GPU.

The first `StreamingRecognize` request contains only streaming_config: LINEAR_PCM, sample_rate_hertz=16000, audio_channel_count=1, language_code=en-US, max_alternatives=1, automatic punctuation and interim results enabled. Every subsequent request contains audio_content bytes. Channel readiness has a ten-second deadline. Once the channel is ready, config and audio are sent without waiting for response metadata (servers may not respond until audio arrives). “Listening” indicates the channel can accept uploads; an entitlement/authentication failure can still follow.

The adapter reads every result and uses the top alternative only. Riva is_final finalizes an audio portion; it does not claim a conversational turn is over. When a response contains finalized text plus trailing partial text, the finalized prefix is retained and one cumulative partial is emitted. When the trailing portion becomes final and no partial remains, the complete block is emitted as final. This prevents a single response’s trailing partial from replacing a separate incomplete final command. Prefix/context is bounded to 4,000 characters. `audio_processed` and stability are not treated as sequence IDs, turn IDs, or guaranteed confidence. Empty final boundaries clear pending partial interpretation without inventing text.

Upload buffering, including pending gRPC writes, is bounded at 128KB (approximately four seconds of this PCM format). This intentionally may fail before the ten-second connection deadline if a caller uploads while connecting. write/drain backpressure is honored. Stop, failure, duration expiry, socket disconnect and server shutdown call stream.cancel plus client.close and suppress subsequent callbacks. Existing speech epochs and usage limits still apply. Hosted API errors are reported without provider error details or credentials.

Runtime dependencies are @grpc/grpc-js and @grpc/proto-loader. Unmodified NVIDIA protocol files are vendored under `apps/server/vendor/nvidia-riva` at revision `268890b7286031a6d4950e34f7ce13ed0d4ce621`; NVIDIA MIT and inherited Google Apache-2.0 notices/licenses are preserved. `protobufjs` postinstall was explicitly disabled in pnpm allowBuilds because it only emits a dependency-version warning; no generated build artifact is required. Install and frozen lockfile checks work.

Verification: **45 backend tests pass** and server typecheck passes. New tests include a real local gRPC server checking config-first ordering, metadata, raw PCM, receiving audio before response metadata, transcript delivery and cancellation. Unit tests cover all-result aggregation, advancing audio_processed without false identity assumptions, post-close suppression, bounded backpressure, readiness deadlines, generic authentication errors, and a session-boundary test combining final “add a” plus partial “ca” followed by final “cache” into one valid add-node command. Test-only injected loopback credentials are insecure; environment-selected production transport always uses TLS.

No hosted NVIDIA or Nebius inference has been run with real credentials. The hackathon’s Nemotron-on-Nebius requirement remains supplied by the existing Nebius visual-action/planning agent when configured; NVIDIA-hosted speech alone is not claimed to satisfy it.

## Hackathon configuration preflight

Run `pnpm check:hackathon` from repository root. The script loads the same root `.env` convention as the server and performs **configuration checks only**: nonempty Nebius/NVIDIA keys, an NVIDIA-namespace Nemotron model for live interpretation and effective planning, and an exact HTTPS Nebius Token Factory `/v1` endpoint. Accepted hosts are `api.tokenfactory.nebius.com` and `api.tokenfactory.us-central1.nebius.com`; spoofed suffixes, userinfo, custom ports, queries, fragments, insecure protocols and different API paths are rejected.

Each check prints PASS, MISSING or MISMATCH with generic instructions. Configured values and secrets are never printed. Missing or mismatched configuration exits nonzero. The command does not call the network, spend inference credits, validate credentials/model entitlement, assess latency, or certify submission eligibility. It explicitly says live inference and submission are unverified.

`config.ts` now normalizes optional provider settings consistently for the application, generation and preflight. In particular, blank `NEBIUS_PLANNING_MODEL` falls back to `NEBIUS_MODEL`; blank `NEBIUS_BASE_URL` uses the default Token Factory endpoint. This fixes a real case where copying a blank optional planning field from `.env.example` caused scene generation to silently return a demo template despite a configured live model.

Verification: **50 backend tests pass** and server typecheck passes. The five additional tests cover no-network/no-secret output, missing keys/incorrect model families, malicious host suffixes and unsafe endpoint forms, blank setting normalization, and actual mocked live scene generation using the main model when planning is blank. Local preflight was run: it correctly reports missing keys/model and exits nonzero in the current unconfigured environment. No hosted inference was performed.

## Persistent whiteboard areas and continuous illustration

Scene JSON remains backward compatible: missing `layout` means the existing slide presentation. Whiteboards opt into `layout:'whiteboard'`, optional `viewport:{x,y,zoom}` (world top-left, zoom 0.25–2), `areas:[{id,label,x,y,width,height}]`, and `activeAreaId`. Object and area x/y coordinates accept ±1,000,000 world units; existing width/height limits remain. Active area IDs and duplicates are validated. Existing projects with no board fields still parse.

Shared exports now include BoardViewport/BoardArea/BoardNavigation schemas and types, `getSceneViewport(scene)`, `applyBoardNavigation(scene,navigation)`, and `appendIllustration(scene,generatedScene)`. Navigation is one of `{direction:'left'|'right'|'up'|'down'}`, `{areaId}`, `{targetId}`, or `{zoom:'in'|'out'|'reset'}`. Camera directions create or visit named 1200×675 areas spaced 1320 horizontally and 795 vertically; object coordinates and IDs never change. Zoom preserves the viewport center. Visiting an object uses its current bounds, including image-anchor resolution.

`appendIllustration` shifts a generated local scene into the current empty area or camera region. If occupied, it finds a free region to the right and moves the camera there. It preserves previous objects, creates a sensible uniquely named area when needed and preserves existing area labels, and remaps colliding object/connection IDs plus anchors/endpoints. The 300-object and 500-connection scene limits fail with a clear message rather than dropping prior content.

New validated visual actions:

- `navigate` with `navigation`.
- `move` with existing top-level `targetId` and finite bounded `dx`/`dy`.
- `add_illustration` with prepositioned `objects`, `connections`, `area`, `viewport`, and `source:'demo'|'live'`.

The frontend merges add_illustration objects/connections as received, replaces/adds the supplied area by ID, selects it as activeAreaId, and applies the supplied viewport. It must not shift the objects a second time. New `add_node` actions on boards include a complete `object` placed relative to the current camera.

Direct whiteboard phrases are resolved before the live model: “let’s go right”, “scroll right”, “go to Start”, “go to database”, “zoom in/out”, “reset zoom”, and “move database right”. Move defaults to 200 units and supports explicit amounts up to 2400; target ambiguity or unknown names skip. Camera motion and object movement are separate operations. Existing image anchors are resolved before movement-bound checks. All navigation, movement and creation require final speech, preventing partial transcript drift from changing saved state.

“Draw/illustrate <idea>” triggers a separate `planning` state and the existing Nebius scene planner, choosing math/architecture/slide from the explicit idea. The same configured planning model, usage caps and server-only credentials apply. No model provider was changed. Planning accepts the session AbortSignal, is bounded to 25 seconds, and checks scene revision/generation before append/dispatch; obsolete results cannot enter a board. Demo mode inserts a predefined template, with `source:'demo'` and an explicit reason stating no model generation occurred.

Camera/area-only scene snapshots still invalidate pending interpretation, but keep acknowledgements valid for already-dispatched actions if scene ID/layout, objects and connections are unchanged. This allows the frontend to focus an off-screen highlight target before acknowledging its rendered effect. Changes to actual object content/geometry still invalidate affected pending actor history as before.

Verification: **62 backend tests pass**, including old JSON compatibility, world bounds, object-preserving camera moves, named-area revisit, center-preserving zoom, repeated append/remapped graph/image identities, move versus pan, ambiguous targets, final-only creation, stale planning cancellation, current-camera node placement, and acknowledgement after camera-only focus. Shared and server typechecks pass. Whiteboards are finite bounded world coordinates with a persistent camera; no claim of unbounded GPU rendering, full automatic layout, mathematical correctness, or multi-user collaboration is made.


Whiteboard follow-up checks preserve established labels (including Start) when filling an empty area. Named areas are capped at 200: directional navigation still moves the camera beyond that cap without creating another area or throwing in the UI; appending a new named illustration at capacity reports a clear limit message. Existing empty areas remain reusable.

Explicit typed/demo cue admission now permits a small burst of up to ten messages per rolling two seconds instead of dropping every second cue arriving within 150ms. This preserves ordinary quick intentional navigation after a preceding rendered action while retaining bounded admission. Session latest-pending cancellation still applies; this is not a durable command queue. A WebSocket regression test verifies two sequential deliberate cues under the former timing cutoff both produce actions.

### Live response correction

The fast Nemotron resolver uses a 1,024-token cap with `extra_body.chat_template_kwargs.enable_thinking=false` (verified against the actual Token Factory endpoint). Scene planning retains its separate defaults. Missing/null/empty display reasons receive a default; semantic action/target/evidence checks remain strict. Finish-reason length, refusals, empty bodies, malformed JSON and schema failures return readable errors; session code also suppresses raw Zod/SyntaxError diagnostics. No automatic retries. See STATUS for the matrix speech and browser verification.

### Constrained cue contract

Cue inference now uses strict provider JSON Schema (`ProposalJsonSchema`) rather than loose JSON-object mode. Required-but-unused fields are nullable; `normalizeModelProposal` removes only optional nulls before strict validation. Unsupported matrix mutations and incomplete/tentative commands skip explicitly. Row/column targeting requires a corresponding spoken reference. `ModelResponseError` classifies output-contract failures: speculative speech skips quietly, while completed/typed failures and service errors remain visible. Live strict-schema and full hosted speech-to-action verification passed; see STATUS.

### Voice amendments

`edit_object` carries `targetId` + typed `patch` (shared `ObjectEditPatchSchema`). `applyObjectEdit` returns a new fully validated scene atomically; no IDs change. Matrix rows/cols1..30 preserve overlap/zero-fill; wire cell/category indices are zero-based, speech indices one-based. Final speech only, revision fencing and patch-inclusive dedupe apply. Deterministic exact matrix/rename instructions supplement live Nemotron amendments; interpretation does not silently fall back from a failed live request. Text/metric/label/color/dimensions/chart datum updates use the same helper. Unchanged echoed properties are stripped, actual changed dimensions/values must be grounded, object matching is unambiguous and excludes replacement text. Unsupported symbolic calculations still skip honestly. Integration evidence and remaining latency risk are recorded in STATUS.

## Trusted plugin segregation (10 October 2026)

`packages/shared/src/plugin-contracts.ts` owns plugin payload schemas and compatibility refinement; the core scene schema delegates to it. `packages/shared/src/plugins.ts` is the shared built-in capability registry. `BUILTIN_PLUGINS` is serializable metadata; `createPluginObject` makes valid insertion presets; `getObjectPlugin` resolves explicit plugin identity or a legacy core fallback; `objectTargets` enumerates semantic parts. Scene target validation and resolver context use this registry. No remote plugin loading, arbitrary scripts, markup execution, or user-defined renderers are allowed.

Objects retain their existing `kind` and stable IDs. Optional `plugin:{id,version:1}` supports `math.matrix` (matrix), `math.equation` (text with KaTeX notation), `cloud.aws` (node with validated AWS service/optional region), and `uml.class` (node with at most20 attributes and20 methods). Unknown plugins/versions, wrong kinds, inconsistent payloads, and unsupported motion presets fail schema validation. Existing project JSON without plugin metadata still loads; legacy matrix/chart internal IDs are unchanged. Equation support is display/editing of LaTeX text, not a symbolic editor or proof of support for every mathematical notation. AWS services are semantic built-ins, not an official complete AWS icon library.

UML targets include title/attributes/methods groups and indexed attribute/method entries. AWS targets include service and optional region. Exact nested target IDs from the inspector remain subject to normal server validation; natural-language references must name the internal part. Model context includes registered capabilities and semantic target labels, while image data remains excluded. Scene generation may return these bounded plugin payloads and must pass the same scene validation.

`motion` on an object configures a supported default; `animation` on an animate action overrides it. Trusted presets are pulse900ms, draw1400ms, and flow1800ms (flow only diagram nodes). The renderer owns cancellation/completion; duration and executable animation code are never model-provided. `draw matrix A` and `Animate matrix A with draw effect` animate an existing target; `draw a matrix lesson` retains whiteboard illustration generation. Exact `Animate <object-id>` supports legacy/core inspector previews without paid inference.

Verification:81 server unit tests pass after registry integration, including compatibility, schema/preset bounds, semantic-part grounding, draw-versus-create behavior, mocked provider capability context, and action dispatch. No hosted provider calls were made for this plugin change. Root owns browser renderer and integration verification.

## Narrated presentation sequences (10 October 2026)

`PresentationSequence` is a bounded, serializable command language shared by every domain. It has at most60 uniquely identified steps: insert editable objects, replace existing objects, attention on up to4 semantic targets, relative camera motion, reveal, bounded wait, and generic lesson context. Insert/update entrances can draw; update `entranceTargets` limits animation to changed internal parts. No step accepts code, arbitrary property paths, or model-controlled animation functions. `applyPresentationStep` validates every mutation atomically; `validatePresentationSequence` rehearses the full sequence against a snapshot before dispatch. Source signatures fence derived demonstrations against intervening edits.

`apps/server/src/domains/index.ts` registers trusted domain planners behind a common `plan(text,scene)` interface. The first adapter is `math.matrix-multiplication`; other domains can emit the same steps without adding domain cases to the player. Nemotron on Nebius remains the general cue/planning provider; the algebra adapter performs deterministic arithmetic and symbolic composition rather than fabricating values. Domain sequence creation is suppressed on speech partials. Ambiguous declarations, incompatible shapes, out-of-range dimensions, and tentative/negated instructions skip.

Supported teacher flow starts on a whiteboard: “today we'll learn about matrix multiplications”; “There are two matrices A and B, A is three by two and B is two by three” (including separate A/B finals, `metrics`, `times`, `*`, and the specifically observed ASR boundary “two matrices, A and Ba is…”); “point to first row of A”; “highlight second row of A in blue”; “now let's scroll down to see the multiplication”; “the rows can be multiplied with the columns of B”. The lesson chooses free space below nearby existing content, retains an anchor in generic scene metadata, and never silently overwrites matrices with incompatible dimensions. Atomic insertion stores lesson context before entrance animation finishes, preserving subsequent speech chunks. Repeated completed instructions are idempotent; interrupted demonstrations can restart using the same derived-object IDs.

Dimensions-only declarations create symbolic entries, not invented numbers. Numeric matrices multiply using deterministic dot products; mixed/symbolic matrices retain symbolic formulas. The demonstration supports up to16 output cells and8 terms per product (declarations retain the schema limit of30 rows/columns). Each step emphasizes one source row and column, writes one result cell, and draws the current equation. Symbolic results display compact `c11`-style names; bounded `math.expressions` stores every cell's complete formula for inspection. Numeric results display actual computed values. A compact result/equation area and camera reframe keep the working context visible.

Derived objects carry generic `derivedFrom` source IDs/signature. `invalidateDerivedResults` hides stale derived objects and removes formula metadata after source changes; the voice edit helper and frontend commit path call it. Sequence-owned scene messages include `sequenceId`; the server preserves action acknowledgements only for prevalidated mutation-prefix fingerprints (SHA256, bounded to100 active records and removed on completion). Other edits still invalidate pending work. The frontend owns XState playback, pause/resume/skip/cancel, renderer completion, and grouped undo; speech listening remains concurrent.

`parseAttentionColor` is shared across domain and general attention: red, blue, green, yellow, orange, purple, pink, cyan, or explicit validated hex. Unsupported explicitly requested colors produce a readable skip instead of silently falling back. Actions and sequences have bounded durations.

Verification at this handoff:89 server tests pass, including real local gRPC protocol tests and eight narrated-math tests for actual ASR boundary normalization, split declarations, symbolic/numeric algebra, semantic attention, colors, dimension/ambiguity safeguards, stale derived results, partial suppression, and sequence acknowledgement across own mutations. Root owns hosted ASR and browser acceptance; those are separate from these unit checks.

## Incremental AWS request architecture (12 October 2026)

The trusted `architecture.aws-request-flow` planner emits the existing generic presentation sequence format. It adds only newly grounded objects and edges to the current scene. Stable object and edge IDs are derived from the scene ID and semantic stage, so repeated declarations do not duplicate components; an explicit autoscaling range correction updates the existing EC2 object without changing its ID. Insert steps may atomically add objects and connections. Existing objects and edges are preserved, and every new edge must resolve both endpoints before the step is accepted.

The editable diagram maps the generic client to a plain node, API Gateway to `cloud.aws/apigateway`, Route 53 to `cloud.aws/route53`, the regional Application Load Balancer to `cloud.aws/alb`, the API implementation and elastic 5–12 node capacity to an EC2 Auto Scaling group, and the database to RDS PostgreSQL primary-writer and grouped multiple-read-replica objects. The replica group deliberately has no invented instance count; a count is added only when the speaker supplies one. The full flow uses a compact 900×400 world-coordinate footprint: client, gateway, ALB, and compute form the top row; Route 53 and the PostgreSQL writer/read replicas form the lower row, with editable explanatory notes below. AWS service cards leave enough height for their service name, concise role label, and implementation detail; directional edges avoid captions over card content. A finite slide planner starts below the authored title area, searches for a collision-free region, and skips with whiteboard guidance when the slide is full. A whiteboard planner places the flow within the unobstructed screen area (beside the left controls and above the voice dock), accounting for current camera position and zoom; above about 100% zoom it asks the user to zoom out so the complete diagram fits. The first insertion selects space for the entire flow so later clauses remain aligned. If an unrelated camera action pans the flow away from that safe view, a later architecture insertion first adds a bounded camera step to bring the existing flow back into view; stored object coordinates and IDs do not change. Route 53 is shown as a DNS/policy relation to the regional API endpoint, not as an HTTP proxy in the request path. The short label identifies latency/geographic DNS routing and the note says the nearest API is not guaranteed; the rationale is that Route 53 latency/geographic policies use configured DNS and health/latency signals as best-effort region selection, not an exact per-request nearest-region guarantee. General language outside the deterministic stages still follows the configured Nemotron resolver.

Final architecture clauses received while an architecture sequence is resolving or playing enter a bounded 20-item FIFO. The session plans each queued clause only after the prior sequence completes, using the latest revision-fenced scene snapshot, which lets separately finalized voice clauses build on their predecessor's insertion. Sequence snapshots are fingerprinted with canonical object-key ordering so schema parsing cannot invalidate an otherwise identical self-commit. A real scene edit, unrelated cue, explicit renderer cancellation or disconnect clears stale queued work. The client sends `animation.cancelled` for cancellation; this invalidates the active actor and never fabricates a completion acknowledgement. Partial transcripts do not enter this queue or create architecture objects.

Verification: the focused architecture suite passes 14 tests, including moved-camera reframe while preserving existing object positions. Acceptance reports shared/server typechecks pass, the unit suite passes 126/126, the workspace build passes, and the dedicated AWS browser flow passes 3/3 with screenshot review. The architecture tests cover segmented flow construction, explicit Route 53 caveats, compact layout on blank/occupied finite slides, whiteboard screen-safe placement/zoom guidance, generated-ID collision safety, API/EC2 labels, stable IDs and no-op replay, explicit range and replica-count updates, unspecified replica counts, atomic connection validation, queue processing against the committed predecessor, stale edit clearing, key-order-safe snapshot acknowledgement, moved-camera recovery, and renderer cancellation. The broader browser suite is still in progress; its final result is recorded in `docs/STATUS.md` after acceptance settles.

## Nemotron-first tiered interpretation (12 October 2026)

Live mode no longer treats Token Factory as the fallback after the rule-based layers. `createNebiusResolver` now takes a `router`; every final cue goes to the fast tier first (`apps/server/src/intent.ts`, strict JSON schema, thinking off, 4-second budget). The decision selects which deterministic grounding tool runs first, supplies a repaired transcript that is tried when the presenter's exact words match nothing, declines `tentative` speech, and marks `unsupported` requests after grounding fails. `lesson` intents that no planner claims become an `author_lesson` proposal, which the session hands to the reasoning tier (`apps/server/src/lessons.ts`). Everything else that the tools cannot ground goes to the core tier exactly as before. Partial speech skips the router, and a router failure or timeout falls back to the previous deterministic order, so the fast tier can only add a decision, never remove validation.

Configuration lives in `readProviderConfig`: `NEBIUS_FAST_MODEL`, `NEBIUS_MODEL`, `NEBIUS_REASONING_MODEL` and `NEBIUS_PLANNING_MODEL`, with every tier defaulting to the core model. `pnpm check:hackathon` verifies all effective tiers are NVIDIA Nemotron IDs; `/api/status` publishes the tier IDs and `routing: "nemotron-first"` without credentials.

Every action and skip now carries `served` (`packages/shared`, `ServedBySchema`): the provider (`nebius-token-factory` or `local-rules`), the model and tier when a model produced the action, the deterministic `planner` when a rule did, the preceding router decision, and latencies. The browser appends this to the activity log so a presenter or judge can see, per cue, that Nemotron Nano routed it and which model or tool completed it. Demo mode records no model.

All tier calls share `apps/server/src/nebius.ts` (`completeJson`): one request shape, strict `json_schema` output, `chat_template_kwargs.enable_thinking` control for Nemotron, per-call timeouts and the existing usage guard. `pnpm bench:nebius` makes real, billable calls through the router, the core resolver and the lesson author and prints p50/p95 per tier; results and dates are recorded in `docs/STATUS.md`.

## Access control, per-client limits and hardening — 12 October 2026

Implemented after the security review of the same day; the full description, limits table, threat model and
deployment checklist are in `docs/SECURITY.md`. Summary of the backend changes:

- `collab/access.ts`: edit tokens (24 random bytes, base64url) minted by `POST /api/projects` or by the client
  for seeded joins; only the SHA-256 is stored (`<id>.access.json`); constant-time comparison; `roleFor`
  (demo always viewer, missing record means legacy open project); `secretMatches` for `ADMIN_TOKEN`.
- `collab/rooms.ts`: members carry a role; `handleSync` answers step 1 for everyone, accepts only empty step 2
  replies from viewers and refuses other viewer writes (`read-only`); `admitWrite` refuses writes past
  `COLLAB_MAX_DOC_BYTES` (`document-full`) with a 1 KiB / 25% cleanup tolerance; awareness frames are size
  capped; `RoomRegistry.authorize`, `createProject` (returns the token once), per-client creation window,
  `deleteProject` (notifies and closes sockets, discards without a final write, deletes files).
- `app.ts`: security headers and a same-origin CSP on every response, HSTS behind a trusted proxy
  (`TRUST_PROXY`), request-log redaction of project ids, per-client `UsageGate` (`usage.forClient(ip)`) for
  model calls and voice, `ConnectionTable` socket cap, join timeout, refused writes close the socket with
  4004, viewers' cues and `listen` refused, `PUT` requires the edit token, `DELETE` requires the admin token.
- `usage.ts`: `UsageGate` interface, per-client hourly/concurrency ceilings in front of the shared ones.
- `generate.ts`, `nebius.ts`, `resolver.ts`, `lessons.ts`, `intent.ts` take a `UsageGate` instead of the
  concrete guard; behaviour is unchanged.
- Dependencies: `@fastify/static` 10.1.6 and `katex` 0.19.0 (audit clean).
