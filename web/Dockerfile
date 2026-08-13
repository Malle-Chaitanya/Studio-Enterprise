# syntax=docker/dockerfile:1
#
# CloudFuze Studio Migrate — SPA image. Build context is the REPO ROOT.
#
# This container serves the built SPA on port 80 and nothing else. The host nginx
# stays in front of it (TLS, the studioent.cftools.live server_name, and the /api/
# + /callback/ proxying), matching how the other ~40 sites on that box are wired —
# e.g. `ats-app 127.0.0.1:8080->80/tcp`.

FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY web/package.json web/package-lock.json ./
RUN npm ci

COPY web/ ./
RUN npm run build

FROM nginx:1.27-alpine AS runtime

# Cache policy lives with the SPA, not on the host, so it ships and is reviewed
# with the code that depends on it.
COPY web/nginx-spa.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null 2>&1 || exit 1
