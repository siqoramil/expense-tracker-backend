# Expense Tracker — Server

Fastify + TypeScript backend for the Expense Tracker mobile app. Persists data in MongoDB and exposes a REST API consumed by the React Native client.

## Stack

- **Fastify 5** — HTTP server
- **MongoDB / Mongoose** — persistence
- **@fastify/jwt** — auth tokens
- **bcryptjs** — password hashing
- **Nodemailer** — SMTP for email verification codes
- **TypeScript** (Node 20+)

## Requirements

- Node.js `>=20`
- MongoDB running locally on port `10100` (or update `MONGO_URL`)
- (Optional) Gmail App Password for SMTP — without it, verification codes are logged to the console

## Setup

```bash
yarn install
cp .env.example .env
# edit .env (JWT_SECRET, SMTP credentials)
```

Start a local MongoDB (via Homebrew) on port 10100:

```bash
brew services start mongodb-community
```

The included `mongod.conf` should bind to `10100`. Verify:

```bash
lsof -iTCP:10100 -sTCP:LISTEN
```

## Scripts

| Command | Description |
|---|---|
| `yarn dev` | Run with `tsx watch` (hot-reload) |
| `yarn build` | Compile TypeScript to `dist/` |
| `yarn start` | Run compiled output |
| `yarn typecheck` | Type-check without emitting |

## Environment variables

See `.env.example`. Required: `MONGO_URL`, `JWT_SECRET`. Optional: `PORT` (default `3000`), `HOST` (default `0.0.0.0`), `SMTP_*`.

## API surface

All routes are prefixed and protected by JWT (except `/auth/*` and `/health`).

| Prefix | Purpose |
|---|---|
| `GET /health` | Liveness probe |
| `/auth` | Register, login, email change, password reset, profile |
| `/categories` | User-defined transaction categories |
| `/wallets` | Wallets / accounts |
| `/tx` | Transactions (income / expense) |
| `/debts` | Debtor & creditor tracking |
| `/budgets` | Monthly budgets |
| `/recurring` | Recurring transactions |
| `/notifs` | Notifications |

## Project layout

```
src/
├── app.ts              # Fastify factory + route registration
├── index.ts            # Entrypoint
├── lib/env.ts          # Env validation
├── plugins/
│   ├── auth.ts         # JWT + auth decorators
│   └── mongo.ts        # Mongoose connection
├── models/             # Mongoose schemas
└── routes/             # Route handlers
```
