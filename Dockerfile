# Crossfire game server + built client, for the host laptop (LAN only).
# Build: docker compose build. Run: docker compose up -d (see docker-compose.yml).

FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY shared shared
COPY client client
RUN npm run build -w client

FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev && npm cache clean --force
COPY shared shared
COPY server server
COPY --from=build /app/client/dist client/dist
RUN mkdir -p /app/logs && chown node:node /app/logs
USER node
EXPOSE 2567
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||2567)+'/api/lan').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "server/src/index.ts"]
