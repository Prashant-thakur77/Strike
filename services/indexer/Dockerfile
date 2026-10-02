# syntax=docker/dockerfile:1.7
# Strike indexer. Build from the repository root (the pnpm workspace):
#   docker build -f services/indexer/Dockerfile -t strike-indexer .
# The image holds one bundled file per command (dist/), the SQL migrations and the deployment records it indexes
# (strike.config.json too, when the repository has one). No secrets: DATABASE_URL and ALCHEMY_API_KEY come from the
# environment at run time.

FROM node:22-bookworm-slim AS build
WORKDIR /repo
ENV PNPM_HOME=/pnpm CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
# Manifests first: the dependency layer is rebuilt only when a manifest or the lockfile changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY sdk/package.json sdk/
COPY services/indexer/package.json services/indexer/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@strike/indexer..." --config.ignore-scripts=true
COPY sdk/ sdk/
COPY services/indexer/ services/indexer/
RUN pnpm --filter @strike/indexer build
# What the runtime needs, gathered in /out: the bundle, the migrations, the deployment records and the config.
RUN --mount=type=bind,target=/ctx \
    mkdir -p /out/indexer /out/contracts \
    && cp -r services/indexer/dist services/indexer/migrations /out/indexer/ \
    && cp -r /ctx/contracts/deployments /out/contracts/ \
    && if [ -f /ctx/strike.config.json ]; then cp /ctx/strike.config.json /out/; fi

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    STRIKE_ROOT=/srv/strike \
    MIGRATIONS_DIR=/srv/strike/indexer/migrations
WORKDIR /srv/strike/indexer
# Read-only for the service user: the files belong to root, the process runs as `node` (uid 1000).
COPY --from=build /out /srv/strike
USER node
EXPOSE 8787
# Liveness only (the process answers); /ready is for load balancers, since it also fails while the chains catch up.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT||8787}/health`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
# node directly (no npm or shell wrapper), so SIGTERM reaches the process and it shuts down gracefully.
CMD ["node", "--enable-source-maps", "dist/main.js"]
