# syntax=docker/dockerfile:1.7
# Strike Telegram bot. Build from the repository root (the pnpm workspace):
#   docker build -f bots/telegram/Dockerfile -t strike-telegram-bot .
# It runs the way the AWS unit does (infra/aws/instance/strike-bot.service): node with tsx on the TypeScript sources.
# No token in the image: TELEGRAM_BOT_TOKEN (and the optional ALCHEMY_API_KEY) come from the environment at run time.
# Subscribers and the log cursor live in DATA_DIR (/data), a volume.

FROM node:22-bookworm-slim AS build
WORKDIR /srv/strike
ENV PNPM_HOME=/pnpm CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY sdk/package.json sdk/
COPY bots/telegram/package.json bots/telegram/
# Production dependencies only (tsx is one: the bot runs from source).
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@strike/telegram-bot..." --config.ignore-scripts=true
COPY sdk/src sdk/src
COPY bots/telegram/src bots/telegram/src

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production DATA_DIR=/data
COPY --from=build /srv/strike /srv/strike
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
WORKDIR /srv/strike/bots/telegram
USER node
CMD ["node", "--conditions=strike-source", "--import", "tsx", "src/index.ts"]
