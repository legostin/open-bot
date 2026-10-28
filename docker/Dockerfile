# Owlbot: one image with the hub, web UI, security console, built-in plugins,
# Claude Code + Codex CLIs and a Chromium for the browser plugin.
# Build from the repo root:  docker build -f docker/Dockerfile -t owlbot .

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --no-audit --no-fund && npm run build

# The hub's own Tailscale node (access from anywhere, packages/tailnet): a static binary for this image's architecture.
FROM golang:1.27-bookworm AS tailnet
# The image pins its own Go; the module may ask for a newer patch release, which Go then fetches.
ENV GOTOOLCHAIN=auto
WORKDIR /src
COPY packages/tailnet/go.mod packages/tailnet/go.sum ./
RUN go mod download
COPY packages/tailnet/*.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/owlbot-tailnet .

FROM node:24-bookworm-slim AS runtime-base
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git sudo ca-certificates curl tini xvfb iptables procps ripgrep jq less openssh-client \
      fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Harness CLIs used as brains (they run as the unprivileged "agent" user).
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code @openai/codex && npm cache clean --force

# Users: hub = owlbot; brain CLIs = agent (shares the owlbot group for workspaces); other plugins = plugin.
RUN groupadd -r owlbot && useradd -r -m -d /home/owlbot -g owlbot -s /bin/bash owlbot \
    && groupadd -r agent && useradd -r -M -d /data/home/agent -g agent -G owlbot -s /bin/bash agent \
    && groupadd -r plugin && useradd -r -M -d /data/home/plugin -g plugin -s /usr/sbin/nologin plugin
# Chromium for the browser plugin; keep the version in sync with playwright in package-lock.json.
ARG PLAYWRIGHT_VERSION=1.64.1
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium && chmod -R a+rX /ms-playwright \
    && npm cache clean --force && rm -rf /var/lib/apt/lists/*

COPY docker/sudoers /etc/sudoers.d/owlbot
RUN chmod 0440 /etc/sudoers.d/owlbot && visudo -c

FROM runtime-base
COPY --from=build --chown=root:root /app /app
COPY --from=tailnet /out/owlbot-tailnet /usr/local/bin/owlbot-tailnet
WORKDIR /app
COPY docker/entrypoint.sh /usr/local/bin/owlbot-entrypoint
RUN chmod 0755 /usr/local/bin/owlbot-entrypoint

ENV NODE_ENV=production \
    OWLBOT_APP_ROOT=/app \
    OWLBOT_DATA_DIR=/data \
    OWLBOT_HOST=0.0.0.0 \
    OWLBOT_PORT=8080 \
    OWLBOT_CONSOLE_PORT=8081 \
    OWLBOT_ISOLATION=users \
    OWLBOT_TAILNET_BIN=/usr/local/bin/owlbot-tailnet \
    DISPLAY=:99 \
    DISABLE_AUTOUPDATER=1 \
    LANG=C.UTF-8

VOLUME /data
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD curl -fsS http://127.0.0.1:8080/api/auth/state >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/owlbot-entrypoint"]
CMD ["start"]
