# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS build

ARG VITE_ROUTING_PUBLIC_KEYS="{}"
ARG VITE_PLATFORM_DEFAULT_HOSTS=""

# 必须加引号：JSON 的 {} 与逗号分隔 host 在 ENV 展开时否则会被截断/污染
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    VITE_ROUTING_PUBLIC_KEYS="$VITE_ROUTING_PUBLIC_KEYS" \
    VITE_PLATFORM_DEFAULT_HOSTS="$VITE_PLATFORM_DEFAULT_HOSTS"

RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=b8im-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store \
    && pnpm fetch --frozen-lockfile

COPY . /app
RUN --mount=type=cache,id=b8im-pnpm-store,target=/pnpm/store,sharing=locked \
    pnpm config set store-dir /pnpm/store \
    && pnpm install --offline --frozen-lockfile \
    && pnpm run build

FROM nginx:1.28-alpine AS runtime

COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
