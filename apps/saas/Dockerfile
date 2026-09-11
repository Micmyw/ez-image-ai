FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11.3.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY tooling ./tooling
COPY apps/saas ./apps/saas
COPY apps/web-host/package.json ./apps/web-host/package.json
COPY apps/workflows/package.json ./apps/workflows/package.json
COPY apps/jobs-runtime/package.json ./apps/jobs-runtime/package.json
COPY apps/mail-preview/package.json ./apps/mail-preview/package.json
RUN --mount=type=cache,id=ezpic-jobs-pnpm,target=/pnpm/store \
    pnpm install --store-dir=/pnpm/store --frozen-lockfile --filter saas... \
    --network-concurrency=8 --fetch-timeout=300000
# Public build arguments only. Runtime secrets never enter the image build.
ARG NEXT_PUBLIC_SAAS_URL
ARG NEXT_PUBLIC_SITE_NAME=EzPic
ARG NEXT_PUBLIC_SITE_DESCRIPTION="Private prompt-based AI image editing with transparent credits."
ARG NEXT_PUBLIC_SUPPORT_EMAIL=""
ARG NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION=""
ARG NEXT_PUBLIC_GUEST_TURNSTILE_SITE_KEY=""
ARG NEXT_PUBLIC_AVATARS_BUCKET_NAME=ezimageai-avatars-production
ARG NEXT_PUBLIC_POSTHOG_KEY=""
ARG NEXT_PUBLIC_POSTHOG_HOST=""
ARG NEXT_PUBLIC_GOOGLE_ANALYTICS_ID=""
ARG NEXT_PUBLIC_CLARITY_PROJECT_ID=""
ARG NEXT_PUBLIC_MIXPANEL_TOKEN=""
ARG NEXT_PUBLIC_PIRSCH_CODE=""
ARG NEXT_PUBLIC_PLAUSIBLE_URL=""
ARG NEXT_PUBLIC_UMAMI_TRACKING_ID=""
# The dummy DB/auth values exist only in the build stage. No migrations or live
# service calls are run here, and the final stage does not inherit these values.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:1/build
ENV BETTER_AUTH_SECRET=build-only-placeholder-not-a-runtime-secret
ENV RESEND_API_KEY=re_build_only_placeholder
ENV MEDIA_PROVIDER_ADAPTER=kie MEDIA_SAFETY_ADAPTER=sightengine MEDIA_ALLOW_TEST_SAFETY_ADAPTER=false
RUN pnpm --filter @repo/database generate
RUN test -n "$NEXT_PUBLIC_SAAS_URL" && EZPIC_STANDALONE_BUILD=true pnpm --filter saas exec next build --webpack

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=8080 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
COPY --from=build --chown=node:node /app/apps/saas/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/saas/.next/static ./apps/saas/.next/static
COPY --from=build --chown=node:node /app/apps/saas/public ./apps/saas/public
COPY --chown=node:node tooling/certificates/supabase-prod-ca-2021.crt ./tooling/certificates/supabase-prod-ca-2021.crt
USER node
EXPOSE 8080
CMD ["node", "apps/saas/server.js"]
