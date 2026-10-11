# Hackathon architecture and readiness

Checked 8 October 2026 (table refreshed 11 October 2026) against the [overview](https://nebiusglobalaihackathon.devpost.com/) and [official rules](https://nebiusglobalaihackathon.devpost.com/rules). Chosen track: **Best Apps and Agents**.

## Requirement mapping

| Requirement | Vizli path | Verification status |
| --- | --- | --- |
| Use Nebius Token Factory or Nebius AI Cloud | Backend invokes Token Factory for transcript-to-action interpretation and scene generation | Live account execution verified 8 October 2026 (scene generation, cue interpretation, hosted ASR → Nemotron action); broad latency/quality still unmeasured |
| Use NVIDIA open-source models; this track specifies Nemotron through Token Factory | `nvidia/nemotron-3-super-120b-a12b` for `NEBIUS_MODEL`; optional `NEBIUS_PLANNING_MODEL` override | Model ID confirmed against the account with real HTTP 200 completions; `pnpm check:hackathon` passes locally |
| Working user-facing app | Editable slides and expanding whiteboards, voice amendments, domain plugins and narrated lessons with hosted speech and typed cues | Local browser and backend suites pass; public repository published 11 October 2026 under Apache-2.0; deployment, video and submission still pending |
| Nebius Serverless Endpoints/Jobs | Optional future deployment path | Encouraged by track, not mandatory |

NVIDIA-hosted Nemotron ASR is an additional speech service, not the evidence for running on Nebius. Keep the core agent on Nebius Token Factory even when speech comes from NVIDIA. Vercel/Railway can host the frontend/backend under this architecture; the required AI execution is supplied by Token Factory. This is our reading of the published track requirements, not an organizer eligibility decision.

## Intended runtime

Microphone → Railway speech adapter → NVIDIA-hosted Nemotron ASR → transcript → **Nemotron on Nebius Token Factory** → validated scene action → editable canvas.

## Stack alignment decision

| Layer | Selected technology | Role in this track |
| --- | --- | --- |
| Fast tier | NVIDIA Nemotron 3 Nano (`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`) via Token Factory | Nemotron-first intent routing and transcript repair on every final cue (`apps/server/src/intent.ts`) |
| Core tier | NVIDIA Nemotron 3 Super (`nvidia/nemotron-3-super-120b-a12b`) via Token Factory | Free-form visual actions, scene and illustration planning (`resolver.ts`, `generate.ts`) |
| Reasoning tier | NVIDIA Nemotron 3 Ultra (`nvidia/Nemotron-3-Ultra-550b-a55b`) via Token Factory | Authors validated lessons for topics without a built-in planner (`lessons.ts`) |
| Speech input | NVIDIA-hosted Nemotron ASR | Additional NVIDIA integration; does not substitute for Token Factory execution |
| Application | React/TypeScript, Fastify/WebSockets, XState | Application and session logic; no framework is prescribed by the track |
| Editable graphics | SVG/HTML, React Flow, ELK, KaTeX | Structured visual output, mathematical notation and object manipulation |
| Web/API hosting | Nebius Serverless AI Endpoint running the container (`deploy/nebius/`, prepared); Vercel + Railway fallback | The track encourages Nebius Serverless; the endpoint has not been created yet |
| Persistence/assets | In-container `.data` for the demo; Railway PostgreSQL + R2 later | Application data; no database/storage vendor is prescribed |

The tiering follows the track text ("Reach for Nemotron 3 Ultra when you need serious reasoning", "let Nano or Super handle the fast, everyday calls"). Measured on 12 October 2026 with `pnpm bench:nebius`: fast p50 1.13 s, core p50 1.48 s, reasoning p50 4.76 s (table in `docs/STATUS.md`). Each action's `served` metadata and the activity log name the tier that produced it, so a judge can see Nemotron deciding on every cue rather than only on the fallthrough.

Keep core Nemotron use meaningful: contextual reference resolution, validated visual actions and generated scenes must be demonstrated through Token Factory. Simple deterministic operations such as image search and navigation can coexist; they are not the primary AI evidence. Do not add Ultra, Serverless Jobs or another service only to mention it in the submission. Use them if the workload needs them.

`pnpm check:hackathon` audits local provider configuration without making paid calls or displaying keys. It rejects missing credentials, models outside the NVIDIA Nemotron namespace, and a core API URL outside the supported Token Factory endpoints. It checks the planning override too. A passing check still requires account model access, live execution, deployment, and the remaining submission artifacts below.

The selected initial model is **Nemotron 3 Super**, `nvidia/nemotron-3-super-120b-a12b`, for both cue interpretation and scene planning. The ID is documented in [Nebius's official model cookbook](https://github.com/nebius/token-factory-cookbook/blob/main/models/nemotron/nemotron3-super-120B.md); it is populated in `.env.example` and now activated in the private local environment. Live scene generation and cue interpretation have been verified with the account; broader latency and quality evaluation remains pending. The earlier Nano-for-cues/Super-for-planning split is deferred to avoid unmeasured routing complexity. A larger planning model remains optional; the track's Ultra suggestion does not mean every request must use Ultra. Current `NEBIUS_MODEL` configuration is flexible and does not itself enforce vendor/model identity.

## Compliance checklist against the Official Rules — 11 October 2026

Checked against the official rules page (loaded in a real browser on 11 October 2026; Devpost blocks plain HTTP clients). Submission Period: 26 August 2026 09:00 PT to 30 October 2026 10:00 PT. Judging Period: 1 to 15 December 2026. Winners announced on or around 11 January 2027.

| Rule (quoted or paraphrased) | Vizli status |
| --- | --- |
| "runs on either Nebius Token Factory or Nebius AI Cloud", defined as "a runtime call to the Token Factory inference API" | Met. Live cue interpretation and scene planning call Token Factory chat completions at runtime; verified with real HTTP 200 responses (STATUS.md). |
| "uses at least one NVIDIA open source model" | Met. `nvidia/nemotron-3-super-120b-a12b` (Nemotron 3 Super) on Token Factory; NVIDIA-hosted Nemotron ASR is additional. |
| Fits one track; Best Apps and Agents: "Power it with Nemotron models on Nebius through Token Factory" | Met. Submit under Best Apps and Agents. Serverless Endpoints/Jobs are "encouraged" and "neither is required". |
| "capable of being successfully installed and running consistently" and "function as depicted in the video" | Met locally: README setup, typecheck, 93 backend and 23 browser tests pass. Keep the video honest about demo versus live mode. |
| New & Existing: created or significantly updated inside the Submission Period | Met. Work began in October 2026; no pre-existing-project explanation is needed. |
| Third-party integrations used in accordance with their terms | Met as far as known: Nebius Token Factory and NVIDIA NIM under their API terms, Wikimedia Commons public API with attribution, vendored Riva protos under MIT/Apache-2.0. |
| "URL to a working demo, hosted application, or test build" available "free of charge and without any restriction" until the Judging Period ends (15 December 2026) | **Not met yet.** No public deployment exists. Deploy (planned Vercel + Railway) with server-only credentials, guest access and the usage limits in place, and keep it running through 15 December 2026. |
| Public repository on GitHub/GitLab/Bitbucket with "all necessary source code, assets, and instructions" | Met: https://github.com/rishulmatta/vizli. |
| "must be public and open source by including an open source license file (such as Apache 2.0, MIT, or MPL 2.0) ... detectable and visible at the top of the repository page" | Met as of 11 October 2026: Apache-2.0 `LICENSE` plus `NOTICE`; GitHub detects it in the About section. The earlier PolyForm Noncommercial license was replaced because it is not open source. |
| README with setup instructions | Met. |
| "highlight how you've used NVIDIA Nemotron ... and where Token Factory accelerated your workflow" | Met. README opens with a dedicated section; this document and STATUS.md give the evidence. Repeat it in the Devpost description. |
| Demo video: under three minutes, shows the project functioning, public on YouTube, "must not include third party trademarks, or copyrighted music" | **Not done.** Record the narrated lesson and marketing cue flows with original or licensed audio only; narrate how Token Factory and Nemotron are used. |
| Text description of features and functionality | **Not done.** Write on the Devpost form. |
| Feedback on Token Factory, AI Cloud and NVIDIA tools | **Not done.** Candidate notes are in STATUS.md: thinking-off controls, strict JSON Schema output, 12-second cue latency ceiling, ASR final/partial semantics. |
| Submission "original work ... solely owned" by the entrant; no Sponsor/Administrator financial support | Met. |
| All materials in English | Met. |

Remaining actions before submitting: public deployment with a stable URL (Nebius Serverless AI Endpoint per `deploy/nebius/README.md`), the YouTube video showing live mode with the tier labels visible, the Devpost description and feedback fields, and a final `pnpm check:hackathon` plus a live cue through the deployed app.

## Judging criteria and how the stack answers them — 12 October 2026

| Criterion (Devpost wording) | Evidence in Vizli |
| --- | --- |
| Technological Implementation: "how effectively does it use Nebius Token Factory or AI Cloud model(s)" | Three Nemotron tiers on Token Factory, Nemotron-first routing on every live cue, strict JSON-schema outputs, measured latency, provenance on every action |
| Design: "a complete, coherent product experience" | Editable canvas, undo, persistence, concurrent listening and animation, labelled demo mode, honest acknowledgements |
| Potential Impact: "a credible, specific case for solving a real problem" | Teachers and presenters narrating while visuals follow; matrix lesson and authored lessons as concrete cases |
| Quality of the Idea: "a creative, non-obvious use of ... NVIDIA Nemotron" | Voice-driven visual explanation with model-authored, server-validated lessons and speech-revision fencing |
