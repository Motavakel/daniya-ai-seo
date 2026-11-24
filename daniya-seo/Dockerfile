FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

# Common runtime
FROM node:24-bookworm-slim AS runtime-base
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist

# Gateway public key
COPY --from=build --chown=node:node /app/src/certs ./certs

RUN mkdir -p /app/var/artifacts \
    && chown -R node:node /app/var

ENTRYPOINT ["/usr/bin/tini", "--"]


# API image
FROM runtime-base AS api
ENV APP_PROCESS=api
USER node
CMD ["node", "dist/main.js"]


# Worker image
FROM runtime-base AS worker
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

ENV APP_PROCESS=worker
ENV CHROME_PATH=/usr/bin/chromium
USER node
CMD ["node", "dist/worker/worker.main.js"]
