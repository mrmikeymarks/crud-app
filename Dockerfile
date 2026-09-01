# syntax=docker/dockerfile:1

# ---------- Stage 1: install dependencies ----------
# Pin a specific major version + slim variant for reproducible, small images.
FROM node:22-alpine AS deps

# All following commands run relative to this directory inside the image.
WORKDIR /app

# Copy ONLY the manifest files first. Docker caches each layer; as long as
# package*.json don't change, the expensive `npm ci` layer below is reused
# even when application source changes.
COPY package.json package-lock.json ./

# `npm ci` installs exactly what the lockfile says (fails if out of sync).
# --omit=dev keeps test/lint tooling out of the production image.
RUN npm ci --omit=dev

# ---------- Stage 2: runtime image ----------
FROM node:22-alpine AS runtime

# Tell libraries (Express etc.) to run in production mode.
ENV NODE_ENV=production

WORKDIR /app

# Bring in only the installed node_modules from the previous stage,
# so nothing from the build environment (npm cache, etc.) leaks into the final image.
COPY --from=deps /app/node_modules ./node_modules

# Now copy the application source. Anything listed in .dockerignore is skipped.
COPY package.json ./
COPY src ./src

# Don't run as root inside the container. The official node image already
# ships a non-privileged `node` user.
USER node

# Documentation only: tells readers/tools which port the app listens on.
# It does NOT publish the port; that happens in compose.yaml.
EXPOSE 3000

# Docker will ping this to decide if the container is "healthy".
# Use 127.0.0.1 rather than localhost: on Alpine, localhost resolves to ::1 (IPv6)
# first, and node above only listens on IPv4.
# Compose uses it to delay dependents until the app is actually ready.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

# The process to start. Exec form (JSON array) makes node PID 1 so it
# receives SIGTERM directly and shuts down cleanly on `docker compose down`.
CMD ["node", "src/server.js"]
