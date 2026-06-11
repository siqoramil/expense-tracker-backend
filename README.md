<div align="center">

# ⚡ ExTracker — Server API

**The secure, fast REST backend powering the ExTracker finance app.**

[![Fastify](https://img.shields.io/badge/Fastify-5.x-000000?style=flat-square&logo=fastify&logoColor=white)](https://fastify.dev)
[![MongoDB](https://img.shields.io/badge/MongoDB-Mongoose_8-47A248?style=flat-square&logo=mongodb&logoColor=white)](https://mongoosejs.com)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D20-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Vitest](https://img.shields.io/badge/Tested_with-Vitest-6E9F18?style=flat-square&logo=vitest&logoColor=white)](https://vitest.dev)
[![License](https://img.shields.io/badge/License-Private-red?style=flat-square)](../LICENSE)

**Production:** `https://expensetracker.ovrin.uz`

</div>

---

## ✨ Features

- 🔐 **JWT authentication** — HS256, configurable expiry, automatic revocation on password reset via `passwordChangedAt` claim check
- 🔑 **Email + password** — bcrypt (12 rounds), per-account brute-force lockout (5 failures → 15-minute lock), timing-safe dummy hash for unknown-email probes
- 🌐 **Google Sign-In** — server-side `id_token` verification via `google-auth-library`; safe explicit linking flow to prevent account-takeover
- 📧 **Email verification codes** — 6-digit OTP for password reset, email change, and account deletion; 10-minute TTL, 5-attempt cap, timing-safe comparison
- 💳 **Wallets** — create/update/delete wallets with name, icon, and color; balance is derived exclusively from transaction writes, never set directly via PATCH
- 💸 **Transactions** — income/expense entries with category + wallet; atomic balance update in a Mongo session when a replica set is available
- 📊 **Monthly stats** — aggregated income, expense, net, and count per month via a single `$group` aggregation
- 📁 **Categories** — bilingual (EN/UZ) income/expense categories; auto-seeded with defaults on first use
- 🏦 **Debts** — `owe_me` / `i_owe` direction, payment ledger with per-payment clamping, archive action
- 📅 **Budgets** — per-category spending limits with unique-index enforcement
- 🔁 **Recurring** — weekly/monthly recurring entries linked to a wallet and category
- 🔔 **Notifications** — server-generated only (budget breach, overdue debt, scheduled bill); client can list, mark read/all-read, and delete
- 🛡️ **Security hardening** — `@fastify/helmet`, strict CORS (origin-anchored regex), global 200 req/min rate limit, per-route tighter caps on credential routes (5–10 req/min), `additionalProperties: false` on all bodies (no silent-strip)
- 📝 **Swagger UI** — full OpenAPI schema at `/docs` in development; disabled in production

---

## 🧱 Tech Stack

| Layer | Library | Version |
|---|---|---|
| 🚀 HTTP server | Fastify | ^5.1 |
| 🗄️ ODM | Mongoose | ^8.8 |
| 🔏 Auth tokens | @fastify/jwt | ^10 |
| 🔒 Password hashing | bcryptjs | ^2.4 |
| 🌐 Google auth | google-auth-library | ^10.6 |
| 📬 Mailer | Nodemailer | ^8.0 |
| 🛡️ Security headers | @fastify/helmet | ^13 |
| 🌍 CORS | @fastify/cors | ^10 |
| ⏱️ Rate limiting | @fastify/rate-limit | ^10.3 |
| 📖 API docs | @fastify/swagger + swagger-ui | ^9 / ^5 |
| 🧪 Testing | Vitest | ^2.1 |
| 🔷 Language | TypeScript | ^5.7 |
| ⚙️ Runtime | Node.js | >=20 |

---

## 🚀 Getting Started

### Prerequisites

- Node.js `>=20`
- Yarn
- MongoDB running locally (default port `27017`)

For **atomic** `/tx` writes, initialise a single-node replica set:

```bash
mongosh --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
# then set in .env:
# MONGO_URL=mongodb://localhost:27017/expense-tracker?replicaSet=rs0
```

Without a replica set the server still runs — transaction writes fall back to non-atomic (fine for development, not recommended for production).

### Install & run

```bash
# 1. Install dependencies
yarn install

# 2. Copy and edit environment variables
cp .env.example .env
#    — set JWT_SECRET (32+ chars), MONGO_URL, and optionally SMTP / Google creds

# 3. Start in dev mode (tsx watch + pino-pretty hot-reload)
yarn dev

# 4. Open the interactive API docs
open http://localhost:3000/docs
```

### Production build

```bash
yarn build          # tsc → dist/
yarn start          # node dist/index.js
```

Run behind an nginx reverse proxy with TLS termination. Set `NODE_ENV=production` and `TRUST_PROXY=true`.

---

## ⚙️ Environment Variables

Validated at boot in `src/lib/env.ts`. The server refuses to start if a required variable is missing or a production-safety rule is violated.

| Variable | Required | Default | Description |
|---|---|---|---|
| `MONGO_URL` | ✅ | — | MongoDB connection string. In production must use `mongodb+srv://` or include `?tls=true`, unless `MONGO_ALLOW_INSECURE=true` is set. |
| `JWT_SECRET` | ✅ | — | HS256 signing secret. Must be **at least 32 characters**. Generate with: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
| `PORT` | — | `3000` | HTTP listen port. |
| `HOST` | — | `0.0.0.0` | HTTP listen host. |
| `NODE_ENV` | — | `development` | Set to `production` for JSON logs, strict CORS, and redacted validation errors. |
| `JWT_EXPIRES_IN` | — | `7d` | Token lifetime (format: `\d+[smhd]`, e.g. `7d`, `1h`). Production enforces a minimum of `1h`. |
| `CORS_ORIGINS` | — | — | Comma-separated origin whitelist for production (e.g. `https://app.example.com`). Dev auto-allows localhost and RFC-1918 addresses. |
| `TRUST_PROXY` | — | `false` | Set `true` behind a reverse proxy so `X-Forwarded-For` is used for per-IP rate limiting. **Never enable without a proxy** — clients could spoof their IP. |
| `MONGO_ALLOW_INSECURE` | — | `false` | Escape hatch for plaintext Mongo on a private network in production. |
| `GOOGLE_WEB_CLIENT_ID` | — | — | Google OAuth Web client ID. Required for `/auth/google`. |
| `GOOGLE_IOS_CLIENT_ID` | — | — | Google OAuth iOS client ID. |
| `GOOGLE_ANDROID_CLIENT_ID` | — | — | Google OAuth Android client ID. |
| `SMTP_HOST` | — | `smtp.gmail.com` | SMTP server host. |
| `SMTP_PORT` | — | `465` | SMTP server port. |
| `SMTP_USER` | — | — | SMTP username / Gmail address. If unset, verification codes are logged (dev only). |
| `SMTP_PASS` | — | — | SMTP password / Gmail App Password. |
| `SMTP_FROM` | — | — | From address, e.g. `ExTracker <noreply@example.com>`. |

---

## 🔌 API Overview

All responses are JSON. Errors follow `{ "error": "<snake_case_code>" }`. Unknown request fields are rejected with `400 bad_request`. Rate limit: **200 req/min per IP** globally, with tighter per-route caps on credential endpoints.

`Authorization: Bearer <token>` is required on all 🔒 routes.

### 🏥 System

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/health` | — | Liveness probe, returns `{ ok, ts }` |
| `GET` | `/docs` | — | Swagger UI (development only) |

### 🔐 Auth — `/auth`

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/register` | — | Create account; seeds default categories; returns `{ token, user }` |
| `POST` | `/auth/login` | — | Email + password sign-in; returns `{ token, user }` |
| `POST` | `/auth/google` | — | Exchange Google `id_token`; creates or returns user |
| `POST` | `/auth/google/link` | 🔒 | Link Google identity to current password account |
| `GET` | `/auth/me` | 🔒 | Current user profile |
| `PATCH` | `/auth/me` | 🔒 | Update name, avatar, or preferences |
| `POST` | `/auth/password/forgot` | — | Send 6-digit reset code via email |
| `POST` | `/auth/password/verify-code` | — | Validate reset code; returns short-lived `verifiedToken` (2 min) |
| `POST` | `/auth/password/reset` | — | Set new password using code + `verifiedToken`; revokes all prior JWTs |
| `POST` | `/auth/email/request-change` | 🔒 | Send code to proposed new email address |
| `POST` | `/auth/email/verify-change` | 🔒 | Confirm code + re-auth; applies email change; revokes prior JWTs |
| `POST` | `/auth/account/request-delete` | 🔒 | Email a 6-digit account-deletion code |
| `POST` | `/auth/account/confirm-delete` | 🔒 | Confirm code + re-auth; cascades-deletes all user data |

### 💸 Transactions — `/tx`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/tx` | 🔒 | List transactions (filter by `?month=YYYY-MM`, `?kind`, `?limit`) |
| `POST` | `/tx` | 🔒 | Create transaction; atomically updates wallet balance |
| `PATCH` | `/tx/:id` | 🔒 | Update transaction; reverses old wallet effect and applies new one |
| `DELETE` | `/tx/:id` | 🔒 | Delete transaction; atomically reverses wallet balance |
| `GET` | `/tx/stats/:month` | 🔒 | Aggregated income, expense, net, and count for `YYYY-MM` |

### 💳 Wallets — `/wallets`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/wallets` | 🔒 | List all wallets |
| `POST` | `/wallets` | 🔒 | Create wallet (name, icon, color, optional seed balance) |
| `PATCH` | `/wallets/:id` | 🔒 | Update name, icon, or color (balance is not patchable here) |
| `DELETE` | `/wallets/:id` | 🔒 | Delete wallet (blocked if any transactions reference it) |

### 📁 Categories — `/categories`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/categories` | 🔒 | List categories; auto-seeds defaults on first request |
| `POST` | `/categories` | 🔒 | Create bilingual (EN/UZ) income or expense category |
| `PATCH` | `/categories/:id` | 🔒 | Update label, icon, color, or kind |
| `DELETE` | `/categories/:id` | 🔒 | Delete category |

### 🏦 Debts — `/debts`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/debts` | 🔒 | List debts (pass `?archived=true` to include archived) |
| `POST` | `/debts` | 🔒 | Create debt (`owe_me` or `i_owe`) |
| `PATCH` | `/debts/:id` | 🔒 | Update debt fields |
| `DELETE` | `/debts/:id` | 🔒 | Delete debt and its payment history |
| `POST` | `/debts/:id/payments` | 🔒 | Record a payment (clamped to remaining balance) |
| `POST` | `/debts/:id/archive` | 🔒 | Mark debt as archived and set paid = amount |

### 📅 Budgets — `/budgets`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/budgets` | 🔒 | List all budgets |
| `POST` | `/budgets` | 🔒 | Create per-category spending limit |
| `PATCH` | `/budgets/:id` | 🔒 | Update spending limit |
| `DELETE` | `/budgets/:id` | 🔒 | Delete budget |

### 🔁 Recurring — `/recurring`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/recurring` | 🔒 | List recurring entries sorted by next due date |
| `POST` | `/recurring` | 🔒 | Create recurring income/expense (weekly or monthly) |
| `PATCH` | `/recurring/:id` | 🔒 | Update recurring entry |
| `DELETE` | `/recurring/:id` | 🔒 | Delete recurring entry |

### 🔔 Notifications — `/notifs`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/notifs` | 🔒 | List notifications, newest first (pagination: `?limit`, `?skip`) |
| `POST` | `/notifs/:id/read` | 🔒 | Mark a single notification as read |
| `POST` | `/notifs/read-all` | 🔒 | Mark all notifications as read |
| `DELETE` | `/notifs/:id` | 🔒 | Delete a notification |

> ⚠️ Notifications are **server-generated only** — clients cannot create them. Creation is restricted to prevent a compromised device from fabricating alerts.

---

## 🔐 Auth Deep-Dive

### Token revocation

Each `User` document stores a `passwordChangedAt` timestamp. The auth preHandler compares the JWT's `iat` against it — tokens older than the last credential change are rejected with `401 token_revoked`. Password reset, email change, and (where applicable) account deletion all bump this timestamp, immediately invalidating every prior session.

### Password reset flow

```
POST /auth/password/forgot        →  emails 6-digit code
POST /auth/password/verify-code   →  validates code, returns verifiedToken (2 min JWT)
POST /auth/password/reset         →  verifiedToken + code + new password → fresh app JWT
```

The two-step verify/reset split prevents a raw code from being replayed directly into the reset endpoint without first passing through the verification step.

### Google Sign-In safety

Google sub IDs are never auto-linked onto an existing password account by email match — this would enable account takeover. Instead, `/auth/google` returns `409 account_link_required` when a collision is found, and the user must call `/auth/google/link` while authenticated with their password. Linking enforces that the Google token's email matches the account's email.

---

## 📜 Scripts

| Command | Description |
|---|---|
| `yarn dev` | Hot-reload server with `tsx watch` and pino-pretty logs |
| `yarn build` | Compile TypeScript to `dist/` via `tsc` |
| `yarn start` | Run compiled output (`node dist/index.js`) |
| `yarn typecheck` | Type-check without emitting (`tsc --noEmit`) |
| `yarn test` | Run Vitest test suite |
| `yarn test:watch` | Vitest in watch mode |
| `yarn lint` | ESLint check |
| `yarn lint:fix` | ESLint auto-fix |
| `yarn format` | Prettier write |
| `yarn format:check` | Prettier check |

---

## 📁 Project Structure

```
server/
├── src/
│   ├── app.ts                  # Fastify factory — plugins, routes, error handler
│   ├── index.ts                # Entrypoint — binds and starts the server
│   ├── lib/
│   │   ├── db-tx.ts            # withMaybeTransaction — replica-set-aware session helper
│   │   ├── defaultCategories.ts# Seeds a starter set of categories for new users
│   │   ├── env.ts              # Validated environment config (required + guard checks)
│   │   ├── mailer.ts           # Nodemailer SMTP wrapper for OTP emails
│   │   ├── normalize.ts        # Email normalization (trim, lowercase)
│   │   ├── schemas.ts          # Shared JSON Schema / OpenAPI building blocks
│   │   └── security.ts         # safeCodeEqual (timing-safe compare), DUMMY_PASSWORD_HASH
│   ├── models/
│   │   ├── User.ts             # User with prefs, googleId, lockout fields
│   │   ├── Wallet.ts           # Wallet with balance
│   │   ├── Category.ts         # Bilingual income/expense category
│   │   ├── Transaction.ts      # Income or expense entry
│   │   ├── Debt.ts             # Debt with payments subdocument
│   │   ├── Budget.ts           # Per-category spending limit
│   │   ├── Recurring.ts        # Weekly/monthly recurring schedule
│   │   ├── Notification.ts     # Server-generated notification
│   │   └── VerificationCode.ts # OTP record (password reset, email change, account delete)
│   ├── plugins/
│   │   ├── auth.ts             # @fastify/jwt + app.auth preHandler decorator
│   │   ├── mongo.ts            # Mongoose connection via fastify-plugin
│   │   └── swagger.ts          # @fastify/swagger + swagger-ui (dev only)
│   └── routes/
│       ├── auth.ts             # /auth — register, login, google, me, password, email
│       ├── transactions.ts     # /tx
│       ├── wallets.ts          # /wallets
│       ├── categories.ts       # /categories
│       ├── debts.ts            # /debts
│       ├── budgets.ts          # /budgets
│       ├── recurring.ts        # /recurring
│       └── notifications.ts    # /notifs
├── package.json
├── tsconfig.json
└── .env.example
```

---

## 🧪 Testing

```bash
# Run the full suite
yarn test

# Run in watch mode during development
yarn test:watch
```

Tests live alongside source files and are run with **Vitest**. They cover route smoke tests and JSON Schema validation. Type correctness is verified separately:

```bash
yarn typecheck   # tsc --noEmit — must pass before every commit
```

---

## 🚢 Deployment Notes

- Build with `yarn build`, serve with `yarn start` behind an nginx reverse proxy (TLS at nginx, plain HTTP to Fastify).
- Set `NODE_ENV=production` — enables JSON (pino) logs, strict CORS from `CORS_ORIGINS`, HSTS headers, and strips validation detail from error responses.
- Set `TRUST_PROXY=true` when nginx forwards `X-Forwarded-For`, so per-IP rate limits are accurate.
- Run MongoDB as a **replica set** (`rs0`) so `/tx` writes are atomic. A single-node replica set is sufficient.
- Back up MongoDB regularly — indexes are defined per model and must be present for correct uniqueness enforcement.
- Swagger UI (`/docs`) is disabled in production automatically.
