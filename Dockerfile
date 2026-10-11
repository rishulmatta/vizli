FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN pnpm install --frozen-lockfile
COPY apps ./apps
COPY packages ./packages
RUN pnpm build
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
ENV DATA_DIR=/app/.data
RUN mkdir -p /app/.data && chown -R node:node /app
USER node
EXPOSE 3001
# Start the server directly: pnpm via corepack would re-download itself at runtime under the node user.
CMD ["apps/server/node_modules/.bin/tsx", "apps/server/src/index.ts"]
