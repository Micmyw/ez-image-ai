FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY tooling ./tooling
COPY apps/jobs-runtime ./apps/jobs-runtime
COPY apps/workflows/package.json ./apps/workflows/package.json
COPY apps/saas/package.json ./apps/saas/package.json
COPY apps/mail-preview/package.json ./apps/mail-preview/package.json
RUN --mount=type=cache,id=ezpic-jobs-pnpm,target=/pnpm/store \
    pnpm install --store-dir=/pnpm/store --frozen-lockfile --filter @repo/jobs-runtime... \
    --network-concurrency=8 --fetch-timeout=300000
# Generation parses configuration but never connects to this non-routable DB.
RUN DATABASE_URL=postgresql://build:build@127.0.0.1:1/build pnpm --filter @repo/database generate
ENV NODE_ENV=production PORT=8080
USER node
WORKDIR /app/apps/jobs-runtime
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/main.ts"]
