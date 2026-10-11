# Hackathon architecture and readiness

Checked 8 October 2026 (table refreshed 11 October 2026) against the [overview](https://nebiusglobalaihackathon.devpost.com/) and [official rules](https://nebiusglobalaihackathon.devpost.com/rules). Chosen track: **Best Apps and Agents**.

## Requirement mapping

| Requirement | Vizli path | Verification status |
| --- | --- | --- |
| Use Nebius Token Factory or Nebius AI Cloud | Backend invokes Token Factory for transcript-to-action interpretation and scene generation | Live account execution verified 8 October 2026 (scene generation, cue interpretation, hosted ASR → Nemotron action); broad latency/quality still unmeasured |
| Use NVIDIA open-source models; this track specifies Nemotron through Token Factory | `nvidia/nemotron-3-super-120b-a12b` for `NEBIUS_MODEL`; optional `NEBIUS_PLANNING_MODEL` override | Model ID confirmed against the account with real HTTP 200 completions; `pnpm check:hackathon` passes locally |
| Working user-facing app | Editable slides and expanding whiteboards, voice amendments, domain plugins and narrated lessons with hosted speech and typed cues | Local browser and backend suites pass; public repository published 11 October 2026 under PolyForm Noncommercial 1.0.0; deployment and submission still pending |
| Nebius Serverless Endpoints/Jobs | Optional future deployment path | Encouraged by track, not mandatory |

NVIDIA-hosted Nemotron ASR is an additional speech service, not the evidence for running on Nebius. Keep the core agent on Nebius Token Factory even when speech comes from NVIDIA. Vercel/Railway can host the frontend/backend under this architecture; the required AI execution is supplied by Token Factory. This is our reading of the published track requirements, not an organizer eligibility decision.

## Intended runtime

Microphone → Railway speech adapter → NVIDIA-hosted Nemotron ASR → transcript → **Nemotron on Nebius Token Factory** → validated scene action → editable canvas.

## Stack alignment decision

| Layer | Selected technology | Role in this track |
| --- | --- | --- |
| Core AI | NVIDIA Nemotron 3 Super via Nebius Token Factory | Required model/platform path; powers actual scene decisions and generation |
| Speech input | NVIDIA-hosted Nemotron ASR | Additional NVIDIA integration; does not substitute for Token Factory execution |
| Application | React/TypeScript, Fastify/WebSockets, XState | Application and session logic; no framework is prescribed by the track |
| Editable graphics | SVG/HTML, React Flow, ELK, KaTeX | Structured visual output, mathematical notation and object manipulation |
| Web/API hosting | Vercel + Railway (planned) | Supporting hosting; Serverless Endpoints/Jobs are optional in the published track |
| Persistence/assets | Railway PostgreSQL + R2 (planned) | Application data; no database/storage vendor is prescribed |

Keep core Nemotron use meaningful: contextual reference resolution, validated visual actions and generated scenes must be demonstrated through Token Factory. Simple deterministic operations such as image search and navigation can coexist; they are not the primary AI evidence. Do not add Ultra, Serverless Jobs or another service only to mention it in the submission. Use them if the workload needs them.

`pnpm check:hackathon` audits local provider configuration without making paid calls or displaying keys. It rejects missing credentials, models outside the NVIDIA Nemotron namespace, and a core API URL outside the supported Token Factory endpoints. It checks the planning override too. A passing check still requires account model access, live execution, deployment, and the remaining submission artifacts below.

The selected initial model is **Nemotron 3 Super**, `nvidia/nemotron-3-super-120b-a12b`, for both cue interpretation and scene planning. The ID is documented in [Nebius's official model cookbook](https://github.com/nebius/token-factory-cookbook/blob/main/models/nemotron/nemotron3-super-120B.md); it is populated in `.env.example` and now activated in the private local environment. Live scene generation and cue interpretation have been verified with the account; broader latency and quality evaluation remains pending. The earlier Nano-for-cues/Super-for-planning split is deferred to avoid unmeasured routing complexity. A larger planning model remains optional; the track's Ultra suggestion does not mean every request must use Ultra. Current `NEBIUS_MODEL` configuration is flexible and does not itself enforce vendor/model identity.

## Before claiming submission readiness

1. Configure server-only NVIDIA and Nebius credentials and exact account-supported Nemotron model IDs.
2. Verify an actual NVIDIA streaming session with partial/final transcripts, then verify a meaningful visual action and scene generation through Token Factory. Typed fallback and deterministic image search alone are insufficient evidence of the core agent.
   Fast Nemotron cue interpretation now uses a 1,024-token cap and verified thinking-off controls (`extra_body.chat_template_kwargs.enable_thinking=false`); scene planning retains its 5,000-token budget and reasoning defaults. Cue output uses provider-enforced strict JSON Schema. Optional nulls are normalized before semantic validation. Malformed speculative speech waits for the final phrase; completed malformed/truncated responses produce readable errors without hidden demo fallback or automatic paid retries.
3. Record sanitized model IDs/provider request evidence without API keys, raw private audio, or private transcripts. Test model failures and reconnects.
4. Deploy a usable public demo with isolated guest projects; provide clear microphone/typed-cue instructions.
5. Prepare a public repository, owner-approved open-source license, setup README, project description, a public demo video no longer than three minutes, and requested platform feedback. The repository is public with a PolyForm Noncommercial 1.0.0 license chosen by the owner on 11 October 2026. That license is source-available, not OSI-approved open source; confirm with the organizers whether it satisfies the published "open-source license" requirement before submitting, or be prepared to relicense.

Live provider success is now verified: Nemotron scene generation and cue interpretation on Nebius, and NVIDIA hosted ASR streaming a synthetic recording through to a visual action. Both server-only credentials are configured and the configuration preflight passes. Public deployment and hackathon submission remain unperformed; the repository and license exist as of 11 October 2026. See `docs/STATUS.md` for exact evidence and limits.
