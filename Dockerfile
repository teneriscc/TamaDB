# syntax=docker/dockerfile:1

# ─── Stage 1: build ────────────────────────────────────────────────────────────
# Full Node image: has the toolchain needed to compile TypeScript (tsc) to dist/.
FROM node:24 AS build

WORKDIR /app

# Commit hash for /health build-info. The runtime image has no .git, so the
# commit is injected at build time (CI passes --build-arg TAMADB_COMMIT=$CI_COMMIT_SHA).
# Defaults to empty → the build-info generator records 'unknown'.
ARG TAMADB_COMMIT=""
ENV TAMADB_COMMIT=$TAMADB_COMMIT

# Install ALL dependencies (incl. devDependencies like typescript) using the
# lockfile for reproducible builds. Copying only manifests first keeps this
# layer cached unless dependencies change.
COPY package.json package-lock.json ./
RUN npm ci

# Compile: tsc -p tsconfig.json → dist/, then generate dist/build-info.json
# (postbuild). scripts/ is needed for the postbuild generator.
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

# Produce a production-only dependency tree for the runtime stage.
RUN npm prune --omit=dev


# ─── Stage 2: runtime ──────────────────────────────────────────────────────────
# Slim Alpine image ships only the compiled output + production deps.
FROM node:24-alpine AS runtime

# tini gives us a proper PID 1 that reaps zombies and forwards SIGTERM/SIGINT
# to the Node process (TamaDB handles these for graceful shutdown).
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    TAMADB_PORT=3000 \
    TAMADB_HOST=0.0.0.0

WORKDIR /app

# Copy production node_modules and compiled app from the build stage.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Persistence dir: TamaDB writes state to ./.tamadb-data unless
# TAMADB_STORAGE_MODE=memory. Create it and hand ownership to the non-root
# `node` user (built into the official image) so writes succeed.
RUN mkdir -p /app/.tamadb-data && chown -R node:node /app

USER node

EXPOSE 3000

# Declare the state directory as a volume so data survives container restarts.
VOLUME ["/app/.tamadb-data"]

# Liveness/readiness: hit the /health route with Node itself (no curl/wget in
# the image). Exit non-zero on failure so Docker marks the container unhealthy.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TAMADB_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
