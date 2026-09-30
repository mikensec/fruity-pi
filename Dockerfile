# fruity-pi container image: the dashboard, the supervisor and all pi instances run inside.
#   docker build -t fruity-pi .
#   docker run -d --name fruity-pi -p 127.0.0.1:7777:7777 -v fruity-pi:/home/node/.fruity-pi fruity-pi

# ---------- build stage: compile server + UI, then drop dev dependencies
FROM node:22-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# ---------- runtime stage
FROM node:22-bookworm-slim
# Tools the agents commonly need. Add your own stack (python libs, go, etc.) in a derived image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates curl bash tini ripgrep jq python3 less procps \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    FRUITY_PI_HOME=/home/node/.fruity-pi \
    FRUITY_PI_HOST=0.0.0.0 \
    FRUITY_PI_PORT=7777 \
    FRUITY_PI_CONTAINER=1 \
    SHELL=/bin/bash

WORKDIR /app
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/bin ./bin
COPY --from=build --chown=node:node /app/web/dist ./web/dist
RUN printf '#!/bin/sh\nexec node /app/dist/cli.js "$@"\n' > /usr/local/bin/fruity-pi \
 && chmod 755 /usr/local/bin/fruity-pi \
 && chown node:node /app \
 && mkdir -p /home/node/.fruity-pi /work \
 && chown node:node /home/node/.fruity-pi /work

# Never run agents as root.
USER node
VOLUME ["/home/node/.fruity-pi"]
EXPOSE 7777
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD curl -fsS http://127.0.0.1:7777/api/auth/me >/dev/null || exit 1
# tini reaps the pi child processes and forwards SIGTERM for a clean shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/app/dist/cli.js", "serve"]
