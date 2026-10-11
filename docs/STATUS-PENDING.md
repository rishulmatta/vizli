# Vizli pending work

Last updated: 11 October 2026. This is the single list of unfinished items. `docs/STATUS.md` records what is done and verified; `docs/HACKATHON.md` has the rule-by-rule checklist. Move an item out of here only when it is actually completed and verified.

## Hackathon submission (deadline 30 October 2026, 10:00 am Pacific)

1. **Public demo URL.** Required by the rules and not done. Planned hosting: Vercel frontend, Railway backend with the Fastify/WebSocket server, Railway Postgres and Cloudflare R2 later. Needs: server-only `NEBIUS_API_KEY`/`NVIDIA_API_KEY` on the host, `ALLOWED_ORIGINS` set to the public frontend origin (the server does not trust its own host automatically), `HOST=0.0.0.0`, guest access with no mandatory signup, and the existing usage limits. Must stay up, free of charge and unrestricted, until the Judging Period ends on 15 December 2026.
2. **Per-guest project isolation on the public server.** The local API is single-user and unauthenticated; a public deployment needs isolated guest projects (or read-only shared demos) before judges share one backend.
3. **Demo video.** Under three minutes, public on YouTube, shows the project working, audio explains the Token Factory and Nemotron usage, no third-party trademarks or copyrighted music. Suggested content: marketing cue flow, a voice amendment, the narrated matrix lesson from `docs/NARRATED_LESSONS.md`.
4. **Devpost text description** of features and functionality, naming Nemotron 3 Super on Token Factory and NVIDIA-hosted Nemotron ASR.
5. **Feedback section** on Token Factory, AI Cloud and NVIDIA tools. Candidate points: thinking-off control via `chat_template_kwargs`, strict JSON Schema output behaviour, cue latency (1.4 to 2.3 s observed, 12 s ceiling, one free-form cell edit timed out), Riva final/partial semantics for continuous narration.
6. **Final pre-submission checks.** `pnpm check:hackathon`, a live typed cue and a live microphone cue through the deployed app, and a re-read of the official rules page.

## Live verification still outstanding

- Natural microphone speech from a real speaker across pauses, corrections and continuous narration. All hosted ASR evidence so far used synthetic recordings; one real user transcript was observed on 8 October.
- Broad Nemotron accuracy and latency measurements on realistic cues; the Nano-for-cues / Super-for-planning split is deferred until measured.
- General (non-deterministic) Nemotron interpretation of plugin parts and lesson phrasing was not re-tested after the plugin and narrated-lesson milestones.
- Docker image build and run; the Dockerfile exists but has never been built here.
- Supabase email-link auth, RLS policies and magic-link delivery were never exercised against a live project. Supabase is optional and not the chosen deployment path.

## Product gaps recorded as boundaries

- Separate clean audience display; presentation currently keeps assistant controls on the same screen.
- Durable or cross-process voice-session resume; reconnect opens a fresh session and resends the scene.
- Arbitrary narration does not continuously invent drawings; only explicit draw/illustrate commands append illustrations. General contextual references ("put a cache next to it") remain unsupported.
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
