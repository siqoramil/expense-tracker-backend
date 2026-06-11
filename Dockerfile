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
ARG NODE_ENV=production
ENV NODE_ENV=$NODE_ENV
WORKDIR /app

COPY package.json yarn.lock ./
RUN if [ "$NODE_ENV" = "production" ]; then \
      yarn install --frozen-lockfile --production && yarn cache clean; \
    else \
      yarn install --frozen-lockfile && yarn cache clean; \
    fi

COPY --from=builder /app/dist ./dist

# Drop root.
USER node

EXPOSE 3000

# The app exposes GET /health (see src/app.ts). PORT defaults to 3000.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
