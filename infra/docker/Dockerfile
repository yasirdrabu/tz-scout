# syntax=docker/dockerfile:1
# One image, several roles: docker run scout <web|worker|scheduler|relay|all-background|migrate|...>

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

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
COPY --from=build --chown=node:node /app/.next/static ./.next/standalone/.next/static
COPY --from=build --chown=node:node /app/public ./.next/standalone/public
# Everything "migrate" reads, at the same relative paths it uses from the working directory.
COPY --from=build --chown=node:node /app/src/platform/db/bootstrap.sql ./src/platform/db/bootstrap.sql
COPY --from=build --chown=node:node /app/src/platform/db/migrations ./src/platform/db/migrations
COPY --from=build --chown=node:node /app/src/modules/tenancy/db/migrations ./src/modules/tenancy/db/migrations
COPY --from=build --chown=node:node /app/src/modules/integrations/db/migrations ./src/modules/integrations/db/migrations
COPY --from=build --chown=node:node /app/src/modules/ai-tasks/db/migrations ./src/modules/ai-tasks/db/migrations
COPY --from=build --chown=node:node /app/src/modules/offers/db/migrations ./src/modules/offers/db/migrations
COPY --from=build --chown=node:node /app/src/modules/accounts/db/migrations ./src/modules/accounts/db/migrations
COPY --from=build --chown=node:node /app/src/modules/intake/db/migrations ./src/modules/intake/db/migrations
COPY --chown=node:node --chmod=755 infra/docker/entrypoint.sh ./entrypoint.sh
USER node
EXPOSE 4240
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["web"]
