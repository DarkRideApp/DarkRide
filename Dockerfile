# DarkRide Docker image
#
# Node 24 (current LTS) + Python 3.13 for the mitmproxy, pymobiledevice3,
# and frida bridges. Uses Debian trixie (13) rather than bookworm (12) —
# mitmproxy 12.2+ requires Python 3.12+, and trixie is the first Debian
# stable to ship a Python new enough. Uses the full (non-slim) image so
# python3, node-gyp build tools, and apt-add-repository work out of the box.
#
# Security: the app defaults to binding 127.0.0.1 which makes the container
# unreachable from outside. Set `HOST=0.0.0.0` explicitly when you want the
# server to accept external connections, e.g.:
#   docker run -p 3000:3000 -e HOST=0.0.0.0 darkride
# See SECURITY.md for the threat model — do not expose publicly without a
# reverse proxy + authentication.

# ---- Stage 1: install Node dependencies ----
FROM node:24-trixie AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---- Stage 2: build frontend + backend ----
FROM node:24-trixie AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && (node scripts/generate-changelog.js || true)

# ---- Stage 3: runtime ----
FROM node:24-trixie AS runtime
WORKDIR /app

# Python 3 + tooling for the venv at /app/.venv
# - python3 / python3-venv: host + venv creator
# - python3-dev / build-essential / libssl-dev / libffi-dev: native extension builds
#   (cryptography, pyOpenSSL, cffi) used by mitmproxy
# - libusb-1.0-0: pymobiledevice3 needs this at runtime for USB access
# - adb: Android Debug Bridge used by the device-manager
# - ca-certificates: trust store for outbound HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        python3-venv \
        python3-dev \
        build-essential \
        libssl-dev \
        libffi-dev \
        libusb-1.0-0 \
        adb \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY python ./python
COPY package.json ./
# Workspace packages are symlinked into node_modules (npm workspaces). The
# symlinks in node_modules point at packages/* — we have to copy the actual
# target directory in too, with its built dist/, or the symlinks resolve to
# nothing. Hit while smoke-testing 2026-05-18: the server crashed on boot
# with "Cannot find module '@darkrideapp/plugin-sdk/utils'" — node was
# following node_modules/@darkrideapp/plugin-sdk → ../../packages/plugin-sdk,
# which didn't exist in the runtime layer.
COPY --from=build /app/packages ./packages

# Create the Python venv at /app/.venv (what `backend/services/python-bridge.ts`
# looks for via `resolve(process.cwd(), '.venv')`). Installing deps at build
# time means the first automation run doesn't pay a 60s startup cost.
RUN python3 -m venv /app/.venv \
    && /app/.venv/bin/pip install --no-cache-dir --upgrade pip \
    && /app/.venv/bin/pip install --no-cache-dir -r /app/python/requirements.txt

RUN mkdir -p data/screenshots

ENV NODE_ENV=production
ENV PORT=3000
ENV DATABASE_PATH=./data/darkride.db
ENV SCREENSHOT_PATH=./data/screenshots
ENV MITMPROXY_DATA=./data/mitmproxy
ENV PRUNE_DAYS=7

EXPOSE 3000

CMD ["node", "dist/backend/index.js"]
