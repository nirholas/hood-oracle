# hood-oracle: autonomous Robinhood Chain launch trader.
#
#   docker build -t hood-oracle .
#   docker compose up --build
#
# Two stages. The build stage compiles the dashboard and the docs site (Vite
# plus the markdown renderer), the server (tsc) and the SDK workspace; the
# runtime stage carries only production dependencies, the compiled output, the
# SQL migrations, and runs as the unprivileged `node` user.

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json ./packages/sdk/
RUN npm ci
COPY tsconfig.json tsconfig.build.json drizzle.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY web ./web
COPY docs ./docs
COPY packages ./packages
RUN npm run build

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
ENV PORT=8080
ENV WEB_DIST=/app/web/dist
ENV KILL_FILE=/app/KILL
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json ./packages/sdk/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist
COPY --from=build /app/packages/sdk/dist ./packages/sdk/dist
# The MCP resource server and the docs routes read the markdown at runtime.
COPY docs ./docs
# The migrator resolves its SQL relative to the compiled file; tsc does not copy .sql.
COPY src/db/migrations ./dist/src/db/migrations
RUN chown -R node:node /app
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "dist/src/index.js"]
