# syntax=docker/dockerfile:1

# ---- Builder: install all deps and compile TypeScript -> dist ----
FROM node:22-alpine AS builder
WORKDIR /app

# Install deps first (cached unless package.json / yarn.lock change)
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Compile
COPY tsconfig.json ./
COPY src ./src
RUN yarn build

# ---- Runtime: production deps + compiled output only ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Tini gives us a proper PID 1 so SIGTERM reaches Node (graceful shutdown).
RUN apk add --no-cache tini

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production && yarn cache clean

COPY --from=builder /app/dist ./dist

# Drop root.
USER node

EXPOSE 3000

# The app exposes GET /health (see src/app.ts). PORT defaults to 3000.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
