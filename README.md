# Expense Tracker — Server

Fastify + TypeScript backend for the Expense Tracker mobile app. Persists user data in MongoDB and exposes a REST API consumed by the React Native client.

Production deployment: `https://expensetracker.ovrin.uz`

## Stack

- **Fastify 5** — HTTP server with `@fastify/helmet`, `@fastify/cors`, `@fastify/rate-limit`
- **MongoDB / Mongoose 8** — persistence
- **@fastify/jwt** — auth tokens (HS256, 7-day expiry)
- **bcryptjs** — password hashing (10 rounds)
- **google-auth-library** — Google ID-token verification
- **Nodemailer** — SMTP for email verification codes
- **@fastify/swagger** + **swagger-ui** — API docs at `/docs`
- **TypeScript 5.7** (Node 20+, ESM)

## Requirements

- Node.js `>=20`
- Yarn
- MongoDB running locally on port `10100` (or update `MONGO_URL`)
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

## Scripts

| Command | Description |
|---|---|
| `yarn dev` | Run with `tsx watch` + pino-pretty logging (hot-reload) |
| `yarn build` | Compile TypeScript to `dist/` |
| `yarn start` | Run compiled output (`node dist/index.js`) |
| `yarn typecheck` | Type-check without emitting |

## Environment variables

Defined in `src/lib/env.ts`. See `.env.example` for the full template.

| Variable | Required | Default | Notes |
|---|---|---|---|
| `MONGO_URL` | Yes | — | e.g. `mongodb://localhost:10100/expense-tracker` |
| `JWT_SECRET` | Yes | — | Long random string |
| `PORT` | No | `3000` | |
| `HOST` | No | `0.0.0.0` | |
| `JWT_EXPIRES_IN` | No | `7d` | |
| `NODE_ENV` | No | `development` | `production` enables stricter CORS + JSON logs |
| `CORS_ORIGINS` | No | — | Comma-separated whitelist (production only) |
| `GOOGLE_WEB_CLIENT_ID` | No | — | Google OAuth Web client ID |
| `GOOGLE_IOS_CLIENT_ID` | No | — | Google OAuth iOS client ID |
| `GOOGLE_ANDROID_CLIENT_ID` | No | — | Google OAuth Android client ID |
| `SMTP_HOST` | No | `smtp.gmail.com` | |
| `SMTP_PORT` | No | `465` | |
| `SMTP_USER` / `SMTP_PASS` | No | — | If empty, codes are printed to console |
| `SMTP_FROM` | No | — | e.g. `Expense Tracker <noreply@example.com>` |

In **development**, CORS automatically allows requests with no `Origin` (mobile / native) and any `localhost`, `127.0.0.1`, `10.x`, `192.168.x` host. In **production**, only origins listed in `CORS_ORIGINS` are accepted.

## API surface

All routes return JSON. Errors use the shape `{ "error": "<snake_case_code>" }` with appropriate HTTP status. Validation failures return `400 bad_request`. Rate limit: **200 requests/minute per IP** (excluding `/health`).

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | — | Liveness probe |
| `GET /docs` | — | Swagger UI |
| `POST /auth/register` | — | Create account, returns `{ token, user }` |
| `POST /auth/login` | — | Email + password sign-in |
| `POST /auth/google` | — | Exchange Google `id_token` for app token |
| `POST /auth/password/forgot` | — | Send reset code via SMTP |
| `POST /auth/password/verify-code` | — | Validate reset code |
| `POST /auth/password/reset` | — | Set new password using code |
| `GET /auth/me` | JWT | Current user profile |
| `PATCH /auth/me` | JWT | Update name / avatar / prefs |
| `POST /auth/email/request-change` | JWT | Send code to new email |
| `POST /auth/email/verify-change` | JWT | Apply email change |
| `/categories` | JWT | User-defined transaction categories |
| `/wallets` | JWT | Wallets / accounts |
| `/tx` | JWT | Transactions (income / expense) |
| `/debts` | JWT | Debtor & creditor tracking |
| `/budgets` | JWT | Monthly budgets |
| `/recurring` | JWT | Recurring transactions |
| `/notifs` | JWT | Notifications |

JWT is sent as `Authorization: Bearer <token>`.

Browse the full schema at `/docs` while the server is running.

## Project layout

```
src/
├── app.ts              # Fastify factory + plugin & route registration
├── index.ts            # Entrypoint — starts the server
├── lib/
│   ├── env.ts          # Env validation
│   └── mailer.ts       # SMTP wrapper (Gmail App Password)
├── plugins/
│   ├── auth.ts         # @fastify/jwt + auth decorators
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
- Set `NODE_ENV=production` to enable JSON logs and the strict CORS whitelist.
- Add the production app's origin (and any web client) to `CORS_ORIGINS`.
- Mongo data should be backed up regularly; the schema relies on indexes defined in each model.
