# Vizli pending work

Last updated: 12 October 2026. This is the single list of unfinished items. `docs/STATUS.md` records what is done and verified; `docs/HACKATHON.md` has the rule-by-rule checklist. Move an item out of here only when it is actually completed and verified.

## Hackathon submission (deadline 30 October 2026, 10:00 am Pacific)

1. **Public demo URL.** Required by the rules and not done. Chosen hosting (12 October 2026): the whole app as one container on a **Nebius Serverless AI Endpoint** (CPU platform, managed HTTPS URL), with inference on Token Factory; scripts and steps are in `deploy/nebius/`. The image builds and runs locally; the `nebius` CLI is not installed on the development machine, so the create step has not been executed and the exact CLI flags must be confirmed against `nebius ai endpoint create --help`. Open questions to verify during the first deploy: WebSocket upgrades through the managed URL, and the two-step create needed because `ALLOWED_ORIGINS` must contain the managed URL that is only known after creation. Fallback: Vercel frontend plus Railway backend. Either way: server-only `NEBIUS_API_KEY`/`NVIDIA_API_KEY`/`ADMIN_TOKEN`, `HOST=0.0.0.0`, `TRUST_PROXY=1`, guest access with no mandatory signup, the usage and per-client limits, the deployment checklist in `docs/SECURITY.md`, and uptime until the Judging Period ends on 15 December 2026.
2. **Access control: verify on the deployment.** Implemented 12 October 2026 (`docs/SECURITY.md`): project ids are read capabilities, edit tokens are write capabilities, the demo is view only, viewers can make their own copy, limits apply per client address and an admin token can wipe a project. Still to verify on the hosted URL: an edit link and a view link opened from two networks, `TRUST_PROXY=1` producing distinct per-client buckets behind the Nebius proxy, the security headers through the managed URL, and the admin delete with the platform secret.
3. **Demo video.** Under three minutes, public on YouTube, shows the project working, audio explains the Token Factory and Nemotron usage, no third-party trademarks or copyrighted music. Suggested content: marketing cue flow, a voice amendment, the narrated matrix lesson from `docs/NARRATED_LESSONS.md`.
4. **Devpost text description** of features and functionality, naming the three Nemotron tiers on Token Factory (Nano router, Super interpreter and planner, Ultra lesson author) and NVIDIA-hosted Nemotron ASR.
5. **Feedback section** on Token Factory, AI Cloud and NVIDIA tools. Candidate points: thinking-off control via `chat_template_kwargs`, strict JSON Schema output behaviour (flat nullable objects decode reliably; models still leave a kind's own fields null, see the lesson normalizer), per-tier latency from `pnpm bench:nebius` in `docs/STATUS.md`, inconsistent model ID casing across the catalog (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, `nvidia/nemotron-3-super-120b-a12b`, `nvidia/Nemotron-3-Ultra-550b-a55b`), Riva final/partial semantics for continuous narration.
6. **Final pre-submission checks.** `pnpm check:hackathon`, a live typed cue and a live microphone cue through the deployed app, and a re-read of the official rules page.

## Live verification still outstanding

- Natural microphone speech from a real speaker across pauses, corrections and continuous narration. All hosted ASR evidence so far used synthetic recordings; one real user transcript was observed on 8 October.
- Nemotron accuracy on realistic cues beyond the benchmark set in `apps/server/src/bench-nebius.ts`; latency per tier is now measured (see `docs/STATUS.md`, 12 October 2026) but only from one machine on one evening.
- Nemotron-authored lessons were verified on two topics (DNS resolution, load balancing) through the real reasoning tier; broader topic coverage, slide-layout placement and a browser run of an authored lesson through the microphone are not yet verified.
- General (non-deterministic) Nemotron interpretation of plugin parts and lesson phrasing was not re-tested after the plugin and narrated-lesson milestones.
- The bounded AWS request-flow parser is not a general speech-to-diagram model. Its documented meeting clauses and typed browser behavior are locally verified; live microphone recognition and general Nemotron interpretation of this architecture story remain unverified.
- Docker image: built and run locally on 12 October 2026 (demo mode, `/api/status` and the static app answered); not yet run with live credentials or on Nebius.
- Supabase email-link auth, RLS policies and magic-link delivery were never exercised against a live project. Supabase is optional and not the chosen deployment path.

## Collaboration (12 October 2026)

Implemented as a Yjs document per project with a shared room on the server (`docs/COLLAB.md`). The items below are not verified and must not be treated as working until the lead records evidence in `docs/STATUS.md`.

- Two physical devices (a Mac and an iPad) editing the same project on the hosted URL.
- The docId-mismatch cache reset: after a server data wipe (the Nebius container clears `.data` on restart) a browser must discard its cached IndexedDB replica when `joined.docId` differs.
- The 3 s offline seed path: a project that cannot join within 3 s seeds a local copy that is later carried as the join seed or reconciled.
- IndexedDB unavailable (disabled storage or private browsing): the project must still open and edit live, without the cached first paint.
- Awareness heartbeat and unload cleanup: peers must disappear promptly on tab close, sleep and network loss.
- Safari and iPad behaviour: WebSocket suspension in the background, IndexedDB eviction and reconnect after the tab returns.
- Long-session document growth from ink tombstones: deleted strokes remain in the document, so long sessions and file size need measurement.
- Memory with many image-heavy rooms: embedded data-URL images are held in every replica and in the server room, bounded only by `MAX_ROOMS`.
- `default` is the shared demo room and is view only; "Make a copy" and `/` create personal projects. Two physical devices on one edit link are still unverified.

## Product gaps recorded as boundaries

- Separate clean audience display; presentation currently keeps assistant controls on the same screen.
- Pen annotations (12 October 2026) are verified only in Chromium through Playwright mouse input and synthetic pen pointer events. Real Apple Pencil, finger and Mac trackpad input in Safari, pressure/tilt, and multi-touch while inking are untested. Ink is not interpreted by Nemotron and cannot be a cue target; ink-to-shape is not planned.
- Durable or cross-process voice-session resume; a reconnect re-joins the room and Yjs reconciles the document in both directions, but the voice session still restarts.
- Arbitrary narration does not continuously invent drawings. Explicit draw/illustrate commands append illustrations; a bounded AWS request-flow planner also handles its documented ordinary meeting clauses. General contextual references ("put a cache next to it") and unrestricted architecture narration remain unsupported.
- Spoken image placement: Commons only, one visible chart required, no axis creation, numeric x positions, candidate choice, background removal or asset caching.
- Symbolic maths: matrices and derivations render but nothing recomputes authored derivations after edits; only the bounded multiplication lesson computes.
- Imports: JSON only. PowerPoint/PDF reconstruction, full Mermaid round-trip and sequence-diagram authoring are future work.
- Library: prepared scenes and saved cue associations, not a searchable illustration marketplace. UML member IDs are positional.
- Animation: primitive presets, no timeline editor, no full spoken pause/resume vocabulary.
- Images are URLs or embedded data; object storage uploads (R2) are not implemented.
- Accounts (Better Auth), persistent per-user quotas, edit-token rotation or expiry, and content moderation are deferred; limits are in-process per server and per client address, and a refused write discards that replica's unsynced local changes (`docs/SECURITY.md`, known gaps).

## Engineering follow-ups

- Bundle size: initial JS about 903 KB before gzip plus a 1.44 MB lazy ELK chunk; split further or raise the warning limit deliberately.
- Low-priority review notes not acted on (11 October): a Riva response ordered `[partial, final]` would be treated as partial; object drag captures camera zoom at pointer-down so an easing camera during a drag can lag the pointer; a trackpad wheel during an active pan ends the pan early; `complete(id)` on a never-acknowledged actor drops it without stopping it.
- Same-host origin allowance for the self-served built app was proposed and not applied; deployments must set `ALLOWED_ORIGINS`.
- Remove stale `.data/e2e-*.json` and `.data/live-image-smoke-*.json` artifacts from before isolated test storage (ignored files, local only).
- Screen-reader audit of the workspace; focus management exists but has not been audited end to end.
- Room-level warnings still name project ids (request logs redact them); restrict log access on the deployment.
- Per-client limits key on the network address, so visitors behind one NAT share buckets; a per-identity scheme needs accounts.
