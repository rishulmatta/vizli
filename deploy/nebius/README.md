# Deploying Vizli on Nebius

Vizli runs end to end on Nebius: the app container on a **Nebius Serverless AI Endpoint** (CPU platform, managed HTTPS URL) and every model call on **Nebius Token Factory**. The hackathon track encourages this path; it is not required, and the Vercel + Railway path in `docs/STATUS-PENDING.md` remains a fallback.

Status: prepared and documented on 12 October 2026, not yet executed. The `nebius` CLI was not installed on the development machine, so the commands below follow the official endpoint quickstart and the `nebius/skills` flag reference; verify flags with `nebius ai endpoint create --help` before running.

## What the container does

One image (root `Dockerfile`) builds the shared package, the web app and the server, then runs the Fastify server on port 3001 serving the built web app and the `/api` and WebSocket session endpoints. Credentials arrive only through environment variables; the image never contains `.env` or `.data`.

## Steps

1. **Prerequisites.** Nebius AI Cloud project with Serverless AI enabled, the `nebius` CLI (0.12.277 or newer) with a profile, Docker, `jq`. Store the two keys as Nebius secrets and note their selectors: `NEBIUS_API_KEY` (Token Factory) and `NVIDIA_API_KEY` (NVIDIA-hosted Nemotron ASR). Create a Container Registry and log Docker in to it.
2. **Build and push.**
   ```bash
   export VIZLI_IMAGE=cr.eu-north1.nebius.cloud/<registry-id>/vizli:$(git rev-parse --short HEAD)
   deploy/nebius/deploy-endpoint.sh build
   ```
3. **Create the endpoint.** The script prints a dry run first. Set `DRY_RUN=0` to create after reviewing the hourly price for the platform and preset; an endpoint bills from create until delete, including idle time.
   ```bash
   export NEBIUS_PROJECT_ID=project-... NEBIUS_API_KEY_SECRET=<selector> NVIDIA_API_KEY_SECRET=<selector>
   DRY_RUN=0 deploy/nebius/deploy-endpoint.sh create
   deploy/nebius/deploy-endpoint.sh url
   ```
4. **Allow the browser origin.** The server only trusts origins listed in `ALLOWED_ORIGINS`, and the managed URL is known only after creation. Endpoints cannot be updated in place, so delete the first endpoint and create it again with `PUBLIC_ORIGIN=<managed https URL>`. The second creation reuses the pushed image and takes about as long as the first.
5. **Smoke test.** `deploy/nebius/deploy-endpoint.sh smoke` prints `/api/status`; expect `"mode":"live"`, `"routing":"nemotron-first"` and the three model IDs. Then open the URL, type a cue such as “Point to revenue”, and confirm the activity log names the Nemotron tier that served it. Finally run `pnpm check:hackathon` locally against the same values.
6. **Keep it running** through the judging period (ends 15 December 2026) and record the URL in the Devpost submission.

## Notes

- `--auth none` is deliberate: judges must reach the app without a token. The server's own limits (`MAX_*` in `.env.example`) bound voice minutes and model calls per hour.
- Projects are stored under `/app/.data` inside the container, so a restart clears saved projects. Guest isolation on a shared backend is still an open item in `docs/STATUS-PENDING.md`; for judging, treat the deployment as a shared demo canvas.
- `cpu-d3` with `4vcpu-16gb` is the preset from the official quickstart; any CPU platform listed by `nebius compute platform list` works because inference runs on Token Factory, not in the container.
- WebSockets: the managed HTTPS URL fronts the container's HTTP port. Confirm the WebSocket session upgrades through it during the smoke test; if the platform does not pass upgrades, use the Vercel + Railway fallback for the session API and keep Token Factory as the inference provider.
