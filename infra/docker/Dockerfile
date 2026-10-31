# syntax=docker/dockerfile:1
# One image, several roles: docker run scout <web|worker|scheduler|relay|all-background|migrate|...>

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# The web-ui app (interim, until the HTTP layer moves to Hono: the web role serves it at /).
# Its own install; only dist/ leaves this stage.
FROM node:22-bookworm-slim AS web-ui
WORKDIR /app/web-ui
COPY web-ui/package.json web-ui/package-lock.json web-ui/.npmrc ./
RUN npm ci
COPY web-ui/ ./
RUN npm run build

FROM deps AS build
COPY . .
COPY --from=web-ui /app/web-ui/dist ./web-ui/dist
ENV NEXT_TELEMETRY_DISABLED=1
# build:api, not build: the web-ui is already built above. It copies web-ui/dist into the standalone output.
RUN npm run build:api

FROM deps AS prod-deps
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=4240
WORKDIR /app
RUN mkdir -p /app && chown node:node /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/.next/standalone ./.next/standalone
# Everything "migrate" reads, at the same relative paths it uses from the working directory.
COPY --from=build --chown=node:node /app/src/platform/db/bootstrap.sql ./src/platform/db/bootstrap.sql
COPY --from=build --chown=node:node /app/src/platform/db/migrations ./src/platform/db/migrations
COPY --from=build --chown=node:node /app/src/modules/tenancy/db/migrations ./src/modules/tenancy/db/migrations
COPY --from=build --chown=node:node /app/src/modules/integrations/db/migrations ./src/modules/integrations/db/migrations
COPY --from=build --chown=node:node /app/src/modules/ai-tasks/db/migrations ./src/modules/ai-tasks/db/migrations
COPY --from=build --chown=node:node /app/src/modules/offers/db/migrations ./src/modules/offers/db/migrations
COPY --from=build --chown=node:node /app/src/modules/accounts/db/migrations ./src/modules/accounts/db/migrations
COPY --from=build --chown=node:node /app/src/modules/intake/db/migrations ./src/modules/intake/db/migrations
COPY --from=build --chown=node:node /app/src/modules/scoring/db/migrations ./src/modules/scoring/db/migrations
COPY --from=build --chown=node:node /app/src/modules/routing/db/migrations ./src/modules/routing/db/migrations
COPY --from=build --chown=node:node /app/src/modules/crm/db/migrations ./src/modules/crm/db/migrations
COPY --chown=node:node --chmod=755 infra/docker/entrypoint.sh ./entrypoint.sh
USER node
EXPOSE 4240
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["web"]
