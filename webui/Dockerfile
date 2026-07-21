# Agentic SOC — build the version-matched Help Center + standalone web app,
# then serve both from nginx. The build context is the repository root because
# the canonical MkDocs source lives beside (not inside) webui/.

FROM python:3.11-alpine AS docs
WORKDIR /repo
COPY docs/requirements.txt docs/requirements.txt
RUN python3 -m pip install --no-cache-dir --requirement docs/requirements.txt
COPY VERSION mkdocs.yml ./
COPY docs ./docs
COPY overrides ./overrides
COPY scripts/build_docs_bundle.py ./scripts/build_docs_bundle.py

ARG TLSOC_VERSION=unknown
ARG TLSOC_RELEASE_CHANNEL=testing
ARG TLSOC_BUILD_SHA=unknown
ARG TLSOC_BUILD_DATE=unknown
RUN TLSOC_VERSION="${TLSOC_VERSION}" \
    TLSOC_RELEASE_CHANNEL="${TLSOC_RELEASE_CHANNEL}" \
    python3 scripts/build_docs_bundle.py --output /artifact/docs

FROM node:22-alpine AS build
WORKDIR /repo/webui
COPY webui/package.json webui/package-lock.json ./
RUN npm ci
COPY webui/ ./
COPY --from=docs /artifact/docs ./public/docs

# These values are consumed by Vite while compiling the immutable browser bundle.
# Defaults are deliberately non-Stable; Compose/release CI must stamp accepted builds.
ARG TLSOC_VERSION=unknown
ARG TLSOC_RELEASE_CHANNEL=testing
ARG TLSOC_BUILD_SHA=unknown
ARG TLSOC_BUILD_DATE=unknown
# The Help Center is already built in the Python stage. The public `npm run
# build` command still creates it for non-Docker development builds.
RUN npm run build:app

FROM nginx:1.27-alpine

ARG TLSOC_VERSION=unknown
ARG TLSOC_RELEASE_CHANNEL=testing
ARG TLSOC_BUILD_SHA=unknown
ARG TLSOC_BUILD_DATE=unknown
ARG TLSOC_SOURCE_URL=https://github.com/ARYDESTROYER/Agentic-Kibana

LABEL org.opencontainers.image.title="Agentic SOC" \
      org.opencontainers.image.description="Operator console for Agentic SOC" \
      org.opencontainers.image.version="${TLSOC_VERSION}" \
      dev.tlsoc.release.channel="${TLSOC_RELEASE_CHANNEL}" \
      org.opencontainers.image.revision="${TLSOC_BUILD_SHA}" \
      org.opencontainers.image.created="${TLSOC_BUILD_DATE}" \
      org.opencontainers.image.source="${TLSOC_SOURCE_URL}"

COPY webui/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/webui/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1
