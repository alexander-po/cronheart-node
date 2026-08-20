FROM node:22.23-bookworm-slim@sha256:d649c27dae7ba0137b3cef5dd75baa422c08dc3d9e3fc0c23dfb172dc3cc6436

ENV COREPACK_HOME=/home/node/.corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    npm_config_store_dir=/app/.pnpm-store

# Every named-volume mount point has to exist in the image owned by `node`:
# Docker seeds a fresh volume from the image, and the unprivileged user must
# be able to write into it. The pnpm store lives under /app so it shares a
# filesystem with node_modules — pointing it elsewhere makes pnpm relocate it
# into the bind-mounted working tree.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable --install-directory /usr/local/bin \
 && mkdir -p /app/node_modules /app/test/fixture-consumer/node_modules \
             /app/.pnpm-store "$COREPACK_HOME" \
 && chown -R node:node /app /home/node

USER node
WORKDIR /app
