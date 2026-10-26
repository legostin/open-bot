# open-bot: one image with the hub, web UI, security console, built-in plugins,
# Claude Code + Codex CLIs and a Chromium for the browser plugin.
# Build from the repo root:  docker build -f docker/Dockerfile -t openbot .

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --no-audit --no-fund && npm run build

FROM node:24-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      git sudo ca-certificates curl tini xvfb iptables procps ripgrep jq less openssh-client \
      fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Harness CLIs used as brains (they run as the unprivileged "agent" user).
RUN npm install -g --no-audit --no-fund @anthropic-ai/claude-code @openai/codex && npm cache clean --force

# Users: hub = openbot; brain CLIs = agent (shares the openbot group for workspaces); other plugins = plugin.
RUN groupadd -r openbot && useradd -r -m -d /home/openbot -g openbot -s /bin/bash openbot \
    && groupadd -r agent && useradd -r -M -d /data/home/agent -g agent -G openbot -s /bin/bash agent \
    && groupadd -r plugin && useradd -r -M -d /data/home/plugin -g plugin -s /usr/sbin/nologin plugin
COPY docker/sudoers /etc/sudoers.d/openbot
RUN chmod 0440 /etc/sudoers.d/openbot && visudo -c

COPY --from=build --chown=root:root /app /app
WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright install --with-deps chromium && chmod -R a+rX /ms-playwright && rm -rf /var/lib/apt/lists/*
COPY docker/entrypoint.sh /usr/local/bin/openbot-entrypoint
RUN chmod 0755 /usr/local/bin/openbot-entrypoint

ENV NODE_ENV=production \
    OPENBOT_APP_ROOT=/app \
    OPENBOT_DATA_DIR=/data \
    OPENBOT_HOST=0.0.0.0 \
    OPENBOT_PORT=8080 \
    OPENBOT_CONSOLE_PORT=8081 \
    OPENBOT_ISOLATION=users \
    DISPLAY=:99 \
    DISABLE_AUTOUPDATER=1 \
    LANG=C.UTF-8

VOLUME /data
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD curl -fsS http://127.0.0.1:8080/api/auth/state >/dev/null || exit 1
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openbot-entrypoint"]
CMD ["start"]
