# syntax=docker/dockerfile:1.20
FROM node:lts-trixie-slim AS base
ARG USER_UID=1000
ARG USER_GID=1000
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates gosu curl gh git wget ripgrep python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

# Modify the existing node user/group to have the specified UID/GID to match host user
RUN usermod -u $USER_UID --non-unique node \
  && groupmod -g $USER_GID --non-unique node \
  && usermod -g $USER_GID -d /paperclip node

FROM base AS deps
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY cli/package.json cli/
COPY server/package.json server/
COPY ui/package.json ui/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/adapter-utils/package.json packages/adapter-utils/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/skills-catalog/package.json packages/skills-catalog/
COPY packages/teams-catalog/package.json packages/teams-catalog/
COPY packages/adapters/acpx-local/package.json packages/adapters/acpx-local/
COPY packages/adapters/claude-local/package.json packages/adapters/claude-local/
COPY packages/adapters/codex-local/package.json packages/adapters/codex-local/
COPY packages/adapters/cursor-cloud/package.json packages/adapters/cursor-cloud/
COPY packages/adapters/cursor-local/package.json packages/adapters/cursor-local/
COPY packages/adapters/gemini-local/package.json packages/adapters/gemini-local/
COPY packages/adapters/grok-local/package.json packages/adapters/grok-local/
COPY packages/adapters/openclaw-gateway/package.json packages/adapters/openclaw-gateway/
COPY packages/adapters/opencode-local/package.json packages/adapters/opencode-local/
COPY packages/adapters/pi-local/package.json packages/adapters/pi-local/
COPY packages/plugins/sdk/package.json packages/plugins/sdk/
COPY --parents packages/plugins/sandbox-providers/./*/package.json packages/plugins/sandbox-providers/
COPY packages/plugins/paperclip-plugin-fake-sandbox/package.json packages/plugins/paperclip-plugin-fake-sandbox/
COPY packages/plugins/plugin-llm-wiki/package.json packages/plugins/plugin-llm-wiki/
COPY packages/plugins/plugin-workspace-diff/package.json packages/plugins/plugin-workspace-diff/
COPY patches/ patches/
COPY scripts/link-plugin-dev-sdk.mjs scripts/

RUN pnpm install --frozen-lockfile

FROM base AS build
WORKDIR /app
COPY --from=deps /app /app
COPY . .
RUN pnpm --filter @paperclipai/ui build
RUN pnpm --filter @paperclipai/plugin-sdk build
RUN pnpm --filter @paperclipai/server build
RUN test -f server/dist/index.js || (echo "ERROR: server build output missing" && exit 1)

FROM base AS production
ARG USER_UID=1000
ARG USER_GID=1000
WORKDIR /app
COPY --chown=node:node --from=build /app /app
RUN npm install --global --omit=dev @anthropic-ai/claude-code@latest @openai/codex@latest opencode-ai @google/gemini-cli@latest \
  && apt-get update \
  && apt-get install -y --no-install-recommends openssh-client jq \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /paperclip \
  && chown node:node /paperclip

# Browser automation for the QA/UX visual-truth gate (NODE-153).
# Chromium + its OS libraries are needed so agents can render UI surfaces and
# capture screenshots. Browsers MUST live outside HOME: HOME=/paperclip is a
# runtime VOLUME that would otherwise shadow the default ~/.cache/ms-playwright,
# so pin a fixed path baked into the image. `playwright` is already present in
# /app/node_modules via the @playwright/test dependency, so we use the
# version-pinned project binary (no fresh npm fetch → no browser-revision drift).
# chromium-headless-shell is installed explicitly alongside chromium: headless
# launches (chromium.launch({ headless: true })) use the shell, and pinning it
# avoids any "Executable doesn't exist" drift between Playwright revisions.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN cd /app \
  && pnpm exec playwright install --with-deps chromium chromium-headless-shell \
  && rm -rf /var/lib/apt/lists/* \
  && chown -R node:node /ms-playwright

# pilot-screenshot helper: render a URL at a viewport and save a PNG from any
# worktree. The script lives in /app (copied above) and resolves Playwright from
# /app, so the caller's cwd can be the agent's worktree. The /usr/local/bin
# wrapper puts it on PATH.
RUN printf '#!/bin/sh\nexec node /app/scripts/pilot-screenshot.mjs "$@"\n' \
    > /usr/local/bin/pilot-screenshot \
  && chmod +x /usr/local/bin/pilot-screenshot

# Bake the Chromium revision that @playwright/mcp uses (923a6aca / retoma PR #13).
# Agents reach the browser via the Microsoft @playwright/mcp server, spawned with
# `npx @playwright/mcp@<ver>`. That package ships its OWN playwright-core, pinned to
# a DIFFERENT revision than the project's @playwright/test (1.58.2) baked above — so
# the NODE-153 bake does not cover it and agents otherwise re-download Chromium to
# ~/.cache/ms-playwright on first MCP call (~30s cold start + npm-registry dependency
# at spawn). We pin the MCP version and install its EXACT playwright build, depositing
# the matching revision into PLAYWRIGHT_BROWSERS_PATH=/ms-playwright (set above). Both
# revisions coexist by revision number, so @playwright/test and @playwright/mcp are
# each satisfied with zero cold-start download.
# KEEP IN SYNC: the control-plane MCP config must spawn this same pinned version
# (`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, not @latest) or runtime drift returns.
ARG PLAYWRIGHT_MCP_VERSION=0.0.76
RUN PW_VERSION="$(npm view @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} dependencies.playwright)" \
  && echo "Baking Chromium for @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} via playwright@${PW_VERSION}" \
  && npx -y playwright@${PW_VERSION} install --with-deps chromium chromium-headless-shell \
  && rm -rf /var/lib/apt/lists/* \
  && chown -R node:node /ms-playwright

COPY scripts/docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production \
  HOME=/paperclip \
  HOST=0.0.0.0 \
  PORT=3100 \
  SERVE_UI=true \
  PAPERCLIP_HOME=/paperclip \
  PAPERCLIP_INSTANCE_ID=default \
  USER_UID=${USER_UID} \
  USER_GID=${USER_GID} \
  PAPERCLIP_CONFIG=/paperclip/instances/default/config.json \
  PAPERCLIP_DEPLOYMENT_MODE=authenticated \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  OPENCODE_ALLOW_ALL_MODELS=true \
  GEMINI_SANDBOX=false

EXPOSE 3100

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "./server/node_modules/tsx/dist/loader.mjs", "server/dist/index.js"]
