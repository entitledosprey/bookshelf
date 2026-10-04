# syntax=docker/dockerfile:1

# Build on the NATIVE platform of the builder and copy only artefacts into the
# target-arch runtime stage. This avoids QEMU-emulated npm installs, which is
# why every dependency in this project must be pure JavaScript -- a native
# binary built here would be the wrong architecture at runtime. See the
# comment:deps note in server/package.json.
FROM --platform=$BUILDPLATFORM node:24-alpine AS client
WORKDIR /build
COPY client/package*.json ./client/
RUN cd client && npm ci --no-audit --no-fund
COPY shared/ ./shared/
COPY client/ ./client/
RUN cd client && npm run build
# -> /build/server/public

FROM --platform=$BUILDPLATFORM node:24-alpine AS deps
WORKDIR /build
COPY server/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/app/data/bookshelf.db \
    COVER_DIR=/app/data/covers
WORKDIR /app

# node:alpine already ships a `node` user at uid/gid 1000, so creating our own
# at 1000 fails with "gid '1000' in use". Reuse it: the volume still ends up
# owned by 1000, which is what the host expects.
RUN mkdir -p /app/data/covers && chown -R node:node /app

COPY --from=deps   --chown=node:node /build/node_modules ./node_modules
COPY --chown=node:node server/package.json ./package.json
COPY --chown=node:node server/src ./src
COPY --from=client --chown=node:node /build/server/public ./public

USER node
EXPOSE 8080
VOLUME ["/app/data"]

# Never consults Goodreads: a rate-limited upstream must not be able to make
# the container look unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js"]
