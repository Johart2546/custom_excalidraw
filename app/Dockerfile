# ---- build the SPA -----------------------------------------------------------
FROM node:24-bookworm-slim AS build

WORKDIR /app

# NODE_ENV=production is sometimes inherited from the shell; vite lives in
# devDependencies, so ask for them explicitly.
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund

COPY index.html vite.config.mjs ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---- runtime -----------------------------------------------------------------
FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    PORT=5002 \
    APP_DIR=/srv/dist \
    DATA_DIR=/data \
    GALLERY_DIR=/gallery

WORKDIR /srv
COPY server.mjs ./
COPY --from=build /app/dist ./dist
# the websocket server needs `ws`; it ships without dependencies of its own, so
# copying the one folder keeps the runtime image from carrying the whole tree
COPY --from=build /app/node_modules/ws ./node_modules/ws

# files written by tools that default to 0600 would not be readable by an
# unprivileged runtime user, which is how the container is normally started
RUN mkdir -p /data /gallery && chmod -R a+rX /srv

EXPOSE 5002

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5002)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
