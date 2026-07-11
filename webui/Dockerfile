# Standalone Agentic SOC web UI — build + serve (nginx).
# Stage 1: build the SPA. Stage 2: serve static + proxy /api to the backend.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine

ARG TLSOC_VERSION=unknown
ARG TLSOC_BUILD_SHA=unknown
ARG TLSOC_BUILD_DATE=unknown
ARG TLSOC_SOURCE_URL=https://github.com/ARYDESTROYER/Agentic-Kibana

LABEL org.opencontainers.image.title="TLSOC Agentic Triage Web UI" \
      org.opencontainers.image.description="Standalone console for TLSOC agentic SOC triage" \
      org.opencontainers.image.version="${TLSOC_VERSION}" \
      org.opencontainers.image.revision="${TLSOC_BUILD_SHA}" \
      org.opencontainers.image.created="${TLSOC_BUILD_DATE}" \
      org.opencontainers.image.source="${TLSOC_SOURCE_URL}"

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
