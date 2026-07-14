# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS build

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=b8im-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store \
    && pnpm fetch --frozen-lockfile

# 构建上下文可包含 .env.production.local（由 scripts/build-images.sh 写入；dockerignore 必须放行）
COPY . /app
RUN --mount=type=cache,id=b8im-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --offline --frozen-lockfile \
    && if [ -f .env.production.local ]; then \
         echo "using .env.production.local:"; \
         cat .env.production.local; \
       else \
         echo "ERROR: missing .env.production.local (check .dockerignore !.env.production.local)" >&2; \
         exit 1; \
       fi \
    && pnpm run build \
    && js="$(ls dist/assets/index-*.js | head -n1)" \
    && test -n "$js" \
    && grep -q 'idev.love' "$js" \
    && grep -q 'routing-test-20260713' "$js" \
    && echo "post-build asset check ok: $js"

FROM nginx:1.28-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
