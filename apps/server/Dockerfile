# syntax=docker/dockerfile:1
# Build from the repository root:  docker build -f apps/server/Dockerfile -t ts-rtc-server .
# Debian (glibc), not Alpine: mediasoup ships prebuilt mediasoup-worker binaries for glibc Linux.

FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
# Only used if no prebuilt mediasoup-worker matches and it has to be compiled. Not in the
# final image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
RUN pnpm install --frozen-lockfile --prod --filter @ts-rtc/server...

FROM node:24-bookworm-slim
# tini is PID 1: forwards SIGTERM to Node and reaps mediasoup-worker subprocesses.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app ./
COPY packages/protocol/src packages/protocol/src
COPY apps/server/src apps/server/src
COPY apps/server/migrations apps/server/migrations
WORKDIR /app/apps/server
# Behind NAT (any container network but host): also set MEDIA_ANNOUNCED_ADDRESS.
ENV NODE_ENV=production HOST=0.0.0.0 MEDIA_LISTEN_IP=0.0.0.0
# Signaling, and one UDP+TCP port per Worker (MEDIA_PORT_BASE + i).
EXPOSE 3000 40000-40015/udp 40000-40015/tcp
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "src/main.ts"]
