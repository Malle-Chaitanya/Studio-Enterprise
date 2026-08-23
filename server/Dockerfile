# syntax=docker/dockerfile:1
#
# CloudFuze Studio Migrate — API image.
#
# Build context is the REPO ROOT, not server/ (the workflow and compose file both
# pass `.`), so every COPY path below is repo-relative.
#
# Why the runtime base is python:3.13-slim and not node:20-slim:
# the API is a Node service that shells out to scripts/adk_deploy.py for every
# Agent Engine deployment (adkDeployer.ts:478) — Agent Engine is a Python-SDK-only
# flow. Python is therefore a hard runtime dependency, and the ADK/Vertex stack is
# by far the more fragile half. Basing on the interpreter the pipeline is proven
# against (3.13) and adding Node is safer than basing on Node and accepting
# whatever Python the distro happens to carry.

# ---------------------------------------------------------------------------
# Stage 1 — compile TypeScript. Node 20 here matches the version CI has always
# built with; the runtime stage below gets the same major for the same reason.
# ---------------------------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY server/package.json server/package-lock.json ./
RUN npm ci

COPY server/tsconfig.json ./
COPY server/src ./src
COPY server/scripts ./scripts
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — runtime.
# ---------------------------------------------------------------------------
FROM python:3.13-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    # config.ts defaults PORT to 8080. On the target host 8080 is already bound by
    # an unrelated container (ats-app), so the compose file publishes 8083 and the
    # process must listen on it. Set here too so the image is correct standalone.
    PORT=8083 \
    # adkDeployer.ts:469 defaults to `python`. The official python images do provide
    # a `python` symlink, but naming python3 explicitly means this image keeps
    # working if the base is ever swapped for a distro that does not.
    PYTHON_BIN=python3

# curl is kept, not stripped: the container HEALTHCHECK and the deploy smoke test
# both use it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get purge -y --auto-remove gnupg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# TWO installs, in this order, and not `pip install -r requirements.txt`.
#
# google-adk 2.6.2 requires google-genai>=2.9,<3 while google-cloud-aiplatform
# 1.93.0 requires google-genai<2.0.0. No version satisfies both, so a single
# resolve fails outright with ResolutionImpossible. Installing aiplatform first and
# letting adk upgrade google-genai past aiplatform's declared ceiling reproduces
# exactly the (conflicting, and working) state the pipeline is proven on — pip
# check reports the same conflict on the development machine. aiplatform's genai
# pin is stricter than its actual use.
#
# cloudpickle is pinned EXPLICITLY rather than pulled via the
# google-cloud-aiplatform[agent_engines] extra. The extra would drag its own
# versions of packages this block resolves by hand, undoing the ordering above.
# Pinning the one missing package keeps the proven resolution intact.
#
# It is needed at DEPLOY time, not import time: agent_engines serialises the agent
# with cloudpickle when creating the reasoning engine. Nothing in the import check
# below touched it, so the image built green and then failed live on 2026-08-23
# with "cloudpickle is not installed" — ADK deploy fell back to low-code create and
# the agent landed as an undeployed draft. cloudpickle is in the check now so this
# fails at build instead. 3.1.2 is what the development machine deploys with.
#
# Verified in this image on 2026-08-13: every import adk_deploy.py performs
# succeeds. See server/requirements.txt for the full reasoning and for what must
# NOT be added here.
COPY server/requirements.txt ./
RUN pip install --no-cache-dir \
      google-cloud-aiplatform==1.93.0 \
      google-cloud-storage==2.19.0 \
      google-auth==2.56.2 \
      cloudpickle==3.1.2 \
 && pip install --no-cache-dir \
      google-adk==2.6.2 \
      google-genai==2.16.0 \
 && python -c "import importlib; [importlib.import_module(m) for m in ['google.oauth2.service_account','vertexai.agent_engines','vertexai.preview.reasoning_engines','google.adk.tools','google.cloud.storage','cloudpickle']]"

COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# scripts/ must be COPYed explicitly. `tsc` does not emit it and copyAssets.mjs only
# copies src/connectors/fixtures — so scripts/adk_deploy.py is absent from dist/
# entirely. adkDeployer.ts:470 resolves it as the relative path
# 'scripts/adk_deploy.py' against the process CWD, which is this WORKDIR. Ship it
# here or every Agent Engine deployment fails with "no JSON result".
COPY server/scripts ./scripts

# Drop privileges. The API writes nothing outside /tmp — staging for Agent Engine
# goes to GCS, persistence goes to Mongo.
RUN useradd --system --create-home --uid 10001 csge \
 && chown -R csge:csge /app
USER csge

EXPOSE 8083

# Fails the container over on a hung process, not just a crashed one. start-period
# covers Mongo index creation on a cold boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/api/health" || exit 1

CMD ["node", "dist/server.js"]
