# Expense Tracker — Server

Fastify + TypeScript backend for the Expense Tracker mobile app. Persists user data in MongoDB and exposes a REST API consumed by the React Native client.

Production deployment: `https://expensetracker.ovrin.uz`

## Stack

- **Fastify 5** — HTTP server with `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`
- **MongoDB / Mongoose 8** — persistence (replica set required in production for transactional `/tx` writes; standalone mongo falls back to non-transactional writes)
- **@fastify/jwt** — auth tokens (HS256, 7-day expiry, revoked on password reset)
- **bcryptjs** — password hashing (12 rounds)
- **google-auth-library** — Google ID-token verification
- **Nodemailer** — SMTP for email verification codes
- **@fastify/swagger** + **swagger-ui** — API docs at `/docs`
- **TypeScript 5.7** (Node 20+, ESM)

## Requirements

- Node.js `>=20`
- Yarn
- MongoDB running locally on port `10100` (or update `MONGO_URL`). For atomic `/tx` writes use a replica set; a single-node `rs0` works fine for dev.
- (Optional) Gmail App Password for SMTP — without it, verification codes are logged to the console
- (Optional) Google OAuth Client IDs — without them, Google sign-in is disabled

## Setup

```bash
yarn install
cp .env.example .env
# edit .env: set JWT_SECRET, MONGO_URL, and SMTP / Google credentials
```

Start a local MongoDB on port 10100 (Homebrew example):

```bash
brew services start mongodb-community
```

Verify MongoDB is listening on the expected port:

```bash
lsof -iTCP:10100 -sTCP:LISTEN
```

For atomic `/tx` writes (transaction + wallet balance update), initialise a single-node replica set:

```bash
mongosh --port 10100 --eval 'rs.initiate({_id: "rs0", members: [{_id: 0, host: "localhost:10100"}]})'
# then point MONGO_URL at the replica set:
# MONGO_URL=mongodb://localhost:10100/expense-tracker?replicaSet=rs0
```

Without a replica set the server still runs — `/tx` writes execute without a session and are non-atomic. That's fine for dev but **prod should always run a replica set**.

## Scripts

| Command          | Description                                             |
| ---------------- | ------------------------------------------------------- |
| `yarn dev`       | Run with `tsx watch` + pino-pretty logging (hot-reload) |
| `yarn build`     | Compile TypeScript to `dist/`                           |
| `yarn start`     | Run compiled output (`node dist/index.js`)              |
| `yarn typecheck` | Type-check without emitting                             |
| `yarn test`      | Run Vitest suite (smoke + schema validation)            |

## Environment variables

Defined in `src/lib/env.ts`. See `.env.example` for the full template.

| Variable                   | Required | Default          | Notes                                                                                                                                                                                                                               |
| -------------------------- | -------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MONGO_URL`                | Yes      | —                | e.g. `mongodb://localhost:10100/expense-tracker` (append `?replicaSet=rs0` for transactional writes)                                                                                                                                |
| `JWT_SECRET`               | Yes      | —                | Long random string                                                                                                                                                                                                                  |
| `PORT`                     | No       | `3000`           |                                                                                                                                                                                                                                     |
| `HOST`                     | No       | `0.0.0.0`        |                                                                                                                                                                                                                                     |
| `JWT_EXPIRES_IN`           | No       | `7d`             |                                                                                                                                                                                                                                     |
| `NODE_ENV`                 | No       | `development`    | `production` enables stricter CORS + JSON logs and hides validation detail in error responses                                                                                                                                       |
| `CORS_ORIGINS`             | No       | —                | Comma-separated whitelist (production only)                                                                                                                                                                                         |
| `TRUST_PROXY`              | No       | `false`          | Set `true` when behind a reverse proxy / TLS terminator. Makes Fastify honour `X-Forwarded-For` so per-IP rate limits don't lump everyone onto one bucket. **Do not enable without a proxy** — clients could spoof their source IP. |
| `GOOGLE_WEB_CLIENT_ID`     | No       | —                | Google OAuth Web client ID                                                                                                                                                                                                          |
| `GOOGLE_IOS_CLIENT_ID`     | No       | —                | Google OAuth iOS client ID                                                                                                                                                                                                          |
| `GOOGLE_ANDROID_CLIENT_ID` | No       | —                | Google OAuth Android client ID                                                                                                                                                                                                      |
| `SMTP_HOST`                | No       | `smtp.gmail.com` |                                                                                                                                                                                                                                     |
| `SMTP_PORT`                | No       | `465`            |                                                                                                                                                                                                                                     |
| `SMTP_USER` / `SMTP_PASS`  | No       | —                | If empty, codes are printed to console                                                                                                                                                                                              |
| `SMTP_FROM`                | No       | —                | e.g. `Expense Tracker <noreply@example.com>`                                                                                                                                                                                        |

In **development**, CORS automatically allows requests with no `Origin` (mobile / native) and any `localhost`, `127.0.0.1`, `10.x.x.x`, or `192.168.x.x` host (the regex anchors on the host boundary, so `https://192.168.1evil.com` is rejected). In **production**, only origins listed in `CORS_ORIGINS` are accepted.

## API surface

All routes return JSON. Errors use the shape `{ "error": "<snake_case_code>" }` with appropriate HTTP status. Body validation is strict — unknown fields are rejected as `400 bad_request` (Fastify v5's silent-strip default is disabled). Rate limit: **200 requests/minute per IP** globally, with tighter caps on credential-touching auth routes (5–10/min).

| Route                               | Auth | Purpose                                                                                                                                                                                             |
| ----------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                       | —    | Liveness probe                                                                                                                                                                                      |
| `GET /docs`                         | —    | Swagger UI                                                                                                                                                                                          |
| `POST /auth/register`               | —    | Create account, returns `{ token, user }`                                                                                                                                                           |
| `POST /auth/login`                  | —    | Email + password sign-in                                                                                                                                                                            |
| `POST /auth/google`                 | —    | Exchange Google `id_token` for app token. Returns `409 account_link_required` if the email already has a password account — the user must sign in with their password and call `/auth/google/link`. |
| `POST /auth/google/link`            | JWT  | Link a Google identity onto the current account (Google email must match the account email)                                                                                                         |
| `POST /auth/password/forgot`        | —    | Send reset code via SMTP                                                                                                                                                                            |
| `POST /auth/password/verify-code`   | —    | Validate reset code                                                                                                                                                                                 |
| `POST /auth/password/reset`         | —    | Set new password using code; bumps `passwordChangedAt` and **revokes every previously-issued JWT**                                                                                                  |
| `GET /auth/me`                      | JWT  | Current user profile                                                                                                                                                                                |
| `PATCH /auth/me`                    | JWT  | Update name / avatar / prefs (prefs schema is whitelisted)                                                                                                                                          |
| `POST /auth/email/request-change`   | JWT  | Send code to new email                                                                                                                                                                              |
| `POST /auth/email/verify-change`    | JWT  | Apply email change                                                                                                                                                                                  |
| `POST /auth/account/request-delete` | JWT  | Email a 6-digit account-deletion code                                                                                                                                                               |
| `POST /auth/account/confirm-delete` | JWT  | Confirm code **plus** re-auth (password for password accounts; fresh Google `idToken` for Google-only accounts), then permanently delete the user and all data                                      |
| `/categories`                       | JWT  | User-defined transaction categories                                                                                                                                                                 |
| `/wallets`                          | JWT  | Wallets / accounts                                                                                                                                                                                  |
| `/tx`                               | JWT  | Transactions (income / expense) — writes use a Mongo session when the deployment supports it                                                                                                        |
| `/debts`                            | JWT  | Debtor & creditor tracking                                                                                                                                                                          |
| `/budgets`                          | JWT  | Monthly budgets                                                                                                                                                                                     |
| `/recurring`                        | JWT  | Recurring transactions                                                                                                                                                                              |
| `/notifs`                           | JWT  | Notifications — **read-only from the client** (list, mark read, delete). Server-only events generate the records.                                                                                   |

JWT is sent as `Authorization: Bearer <token>`.

Browse the full schema at `/docs` while the server is running.

### Token revocation

Each `User` carries a `passwordChangedAt` timestamp. The auth preHandler rejects any JWT whose `iat` is older than that timestamp, returning `401 token_revoked`. So a stolen token becomes useless the moment the legitimate owner resets their password. The check costs one indexed `findById` per authenticated request.

### Avatar storage

`PATCH /auth/me` accepts initials, an `https://` URL, or a `data:image/...` base64 URI capped at ~600 KB. Storing inline base64 hits Mongo's 16 MB document cap quickly and amplifies oplog writes — production deployments should move avatars to S3/CDN and store only the URL.

## Project layout

```
src/
├── app.ts              # Fastify factory + plugin & route registration
├── index.ts            # Entrypoint — starts the server
├── lib/
│   ├── db-tx.ts        # withMaybeTransaction helper (replica-set fallback)
│   ├── env.ts          # Env validation
│   ├── mailer.ts       # SMTP wrapper (Gmail App Password)
│   └── schemas.ts      # Shared OpenAPI / JSON Schema fragments
├── plugins/
│   ├── auth.ts         # @fastify/jwt + auth decorator (with passwordChangedAt revocation)
│   ├── mongo.ts        # Mongoose connection
│   └── swagger.ts      # OpenAPI / Swagger UI
├── models/             # Mongoose schemas
│   ├── User.ts
│   ├── Wallet.ts
│   ├── Category.ts
│   ├── Transaction.ts
│   ├── Debt.ts
│   ├── Budget.ts
│   ├── Recurring.ts
│   ├── Notification.ts
│   └── VerificationCode.ts
└── routes/             # Route handlers (one file per prefix)
```

## Deployment notes

- Build with `yarn build`, run with `yarn start` behind a reverse proxy (nginx). The production deployment terminates TLS at nginx and forwards to the Fastify process.
- Set `NODE_ENV=production` to enable JSON logs, the strict CORS whitelist, and silenced validation detail in error responses.
- Set `TRUST_PROXY=true` so Fastify reads `X-Forwarded-For` for per-IP rate limiting.
- Add the production app's origin (and any web client) to `CORS_ORIGINS`.
- Run MongoDB as a replica set so `/tx` writes are atomic. Even a single-node `rs0` is enough.
- Mongo data should be backed up regularly; the schema relies on indexes defined in each model.
