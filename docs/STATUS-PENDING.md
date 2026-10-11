# Vizli pending work

Last updated: 12 October 2026. This is the single list of unfinished items. `docs/STATUS.md` records what is done and verified; `docs/HACKATHON.md` has the rule-by-rule checklist. Move an item out of here only when it is actually completed and verified.

## Hackathon submission (deadline 30 October 2026, 10:00 am Pacific)

1. **Public demo URL.** Required by the rules and not done. Chosen hosting (12 October 2026): the whole app as one container on a **Nebius Serverless AI Endpoint** (CPU platform, managed HTTPS URL), with inference on Token Factory; scripts and steps are in `deploy/nebius/`. The image builds and runs locally; the `nebius` CLI is not installed on the development machine, so the create step has not been executed and the exact CLI flags must be confirmed against `nebius ai endpoint create --help`. Open questions to verify during the first deploy: WebSocket upgrades through the managed URL, and the two-step create needed because `ALLOWED_ORIGINS` must contain the managed URL that is only known after creation. Fallback: Vercel frontend plus Railway backend. Either way: server-only `NEBIUS_API_KEY`/`NVIDIA_API_KEY`, `HOST=0.0.0.0`, guest access with no mandatory signup, the existing usage limits, and uptime until the Judging Period ends on 15 December 2026.
2. **Per-guest project isolation on the public server.** The local API is single-user and unauthenticated; a public deployment needs isolated guest projects (or read-only shared demos) before judges share one backend.
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

## Product gaps recorded as boundaries

- Separate clean audience display; presentation currently keeps assistant controls on the same screen.
- Durable or cross-process voice-session resume; reconnect opens a fresh session and resends the scene.
- Arbitrary narration does not continuously invent drawings. Explicit draw/illustrate commands append illustrations; a bounded AWS request-flow planner also handles its documented ordinary meeting clauses. General contextual references ("put a cache next to it") and unrestricted architecture narration remain unsupported.
- Spoken image placement: Commons only, one visible chart required, no axis creation, numeric x positions, candidate choice, background removal or asset caching.
- Symbolic maths: matrices and derivations render but nothing recomputes authored derivations after edits; only the bounded multiplication lesson computes.
- Imports: JSON only. PowerPoint/PDF reconstruction, full Mermaid round-trip and sequence-diagram authoring are future work.
- Library: prepared scenes and saved cue associations, not a searchable illustration marketplace. UML member IDs are positional.
- Animation: primitive presets, no timeline editor, no full spoken pause/resume vocabulary.
- Some ordinary inspector fields commit per keystroke; grouping a focused edit into one undo step is open.
- Images are URLs or embedded data; object storage uploads (R2) are not implemented.
- Better Auth and persistent per-user quota accounting are deferred; current limits are in-process per server.

## Engineering follow-ups

- Bundle size: initial JS about 903 KB before gzip plus a 1.44 MB lazy ELK chunk; split further or raise the warning limit deliberately.
- Low-priority review notes not acted on (11 October): a Riva response ordered `[partial, final]` would be treated as partial; object drag captures camera zoom at pointer-down so an easing camera during a drag can lag the pointer; a trackpad wheel during an active pan ends the pan early; `complete(id)` on a never-acknowledged actor drops it without stopping it.
- Same-host origin allowance for the self-served built app was proposed and not applied; deployments must set `ALLOWED_ORIGINS`.
- Remove stale `.data/e2e-*.json` and `.data/live-image-smoke-*.json` artifacts from before isolated test storage (ignored files, local only).
- Screen-reader audit of the workspace; focus management exists but has not been audited end to end.
- Extract project/transport/audio hooks from `App.tsx` before adding substantial features.
