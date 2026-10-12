#!/usr/bin/env bash
# Deploy Vizli as a Nebius Serverless AI Endpoint (CPU container with a managed HTTPS URL).
# The container serves the built web app and the Fastify/WebSocket API; all inference
# stays on Nebius Token Factory. Read deploy/nebius/README.md first.
#
# Usage:
#   deploy/nebius/deploy-endpoint.sh build        # docker build + push to Nebius Container Registry
#   deploy/nebius/deploy-endpoint.sh create       # create the endpoint (prints a dry run first)
#   deploy/nebius/deploy-endpoint.sh url          # print the managed HTTPS URL of the endpoint
#   deploy/nebius/deploy-endpoint.sh smoke        # curl /api/status through the managed URL
#
# Required environment (export before running; never commit these):
#   NEBIUS_PROJECT_ID   project-... from `nebius config get parent-id`
#   VIZLI_IMAGE         cr.<region>.nebius.cloud/<registry-id>/vizli:<tag>
#   NEBIUS_API_KEY_SECRET, NVIDIA_API_KEY_SECRET   Nebius secret selectors holding the two keys
# Optional:
#   ADMIN_TOKEN_SECRET  Nebius secret selector for ADMIN_TOKEN (enables DELETE /api/projects/:id, see docs/SECURITY.md)
#   VIZLI_ENDPOINT_NAME (default vizli), VIZLI_PLATFORM (default cpu-d3), VIZLI_PRESET (default 4vcpu-16gb)
#   PUBLIC_ORIGIN       https://... managed URL from a previous `create`; required so the browser
#                       app is an allowed origin (see README: the URL is only known after creation)
#   NEBIUS_MODEL, NEBIUS_FAST_MODEL, NEBIUS_REASONING_MODEL   default to the IDs in .env.example
#   DRY_RUN=0           skip the dry run and create for real after confirming the cost
set -euo pipefail
cd "$(dirname "$0")/../.."
name="${VIZLI_ENDPOINT_NAME:-vizli}"
platform="${VIZLI_PLATFORM:-cpu-d3}"
preset="${VIZLI_PRESET:-4vcpu-16gb}"
core="${NEBIUS_MODEL:-nvidia/nemotron-3-super-120b-a12b}"
fast="${NEBIUS_FAST_MODEL:-nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B}"
reasoning="${NEBIUS_REASONING_MODEL:-nvidia/Nemotron-3-Ultra-550b-a55b}"
need() { [ -n "${!1:-}" ] || { echo "Set $1 first (see the header of this script)." >&2; exit 1; }; }
case "${1:-}" in
  build)
    need VIZLI_IMAGE
    docker build -t "$VIZLI_IMAGE" .
    echo "Log in to the registry first if needed (docker login cr.<region>.nebius.cloud), then pushing..."
    docker push "$VIZLI_IMAGE"
    ;;
  create)
    need NEBIUS_PROJECT_ID; need VIZLI_IMAGE; need NEBIUS_API_KEY_SECRET; need NVIDIA_API_KEY_SECRET
    origin="${PUBLIC_ORIGIN:-https://pending.invalid}"
    args=(
      ai endpoint create
      --parent-id "$NEBIUS_PROJECT_ID"
      --name "$name"
      --image "$VIZLI_IMAGE"
      --platform "$platform"
      --preset "$preset"
      --container-port 3001/http
      --auth none
      --env HOST=0.0.0.0
      --env PORT=3001
      --env NODE_ENV=production
      --env TRUST_PROXY=1
      --env "ALLOWED_ORIGINS=$origin"
      --env "NEBIUS_MODEL=$core"
      --env "NEBIUS_FAST_MODEL=$fast"
      --env "NEBIUS_REASONING_MODEL=$reasoning"
      --env NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1
      --env-secret "NEBIUS_API_KEY=$NEBIUS_API_KEY_SECRET"
      --env-secret "NVIDIA_API_KEY=$NVIDIA_API_KEY_SECRET"
    )
    if [ -n "${ADMIN_TOKEN_SECRET:-}" ]; then args+=(--env-secret "ADMIN_TOKEN=$ADMIN_TOKEN_SECRET"); fi
    echo "Dry run:"; nebius "${args[@]}" --dry-run
    if [ "${DRY_RUN:-1}" = "0" ]; then
      echo "Creating. This endpoint bills from create until delete; check https://nebius.com/prices for $platform $preset."
      nebius "${args[@]}" --async --format json | jq '{operation: .id, resource: .resource_id}'
      echo "Poll with: nebius ai endpoint get-by-name --name $name --parent-id $NEBIUS_PROJECT_ID --format json | jq '{state: .status.state, urls: .status.public_endpoints}'"
      [ "$origin" = "https://pending.invalid" ] && echo "Then rerun create with PUBLIC_ORIGIN=<managed https URL> after deleting this first endpoint; the browser needs its own origin allowed."
    else
      echo "Dry run only. Re-run with DRY_RUN=0 to create after reviewing the cost."
    fi
    ;;
  url)
    need NEBIUS_PROJECT_ID
    nebius ai endpoint get-by-name --name "$name" --parent-id "$NEBIUS_PROJECT_ID" --format json \
      | jq -r '.status.public_endpoints[]? | select(startswith("https://"))' | head -1
    ;;
  smoke)
    need NEBIUS_PROJECT_ID
    url="$("$0" url)"
    [ -n "$url" ] || { echo "No managed URL yet; the endpoint may still be starting." >&2; exit 1; }
    curl -sS -m 20 "$url/api/status"; echo
    ;;
  *)
    sed -n '2,20p' "$0"; exit 1 ;;
esac
