import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { env } from './lib/env.js';
import authPlugin from './plugins/auth.js';
import mongoPlugin from './plugins/mongo.js';
import swaggerPlugin from './plugins/swagger.js';
import authRoutes from './routes/auth.js';
import budgetsRoutes from './routes/budgets.js';
import categoriesRoutes from './routes/categories.js';
import debtsRoutes from './routes/debts.js';
import notificationsRoutes from './routes/notifications.js';
import recurringRoutes from './routes/recurring.js';
import transactionsRoutes from './routes/transactions.js';
import walletsRoutes from './routes/wallets.js';

export const buildApp = async () => {
  const isProd = env.nodeEnv === 'production';
  const app = Fastify({
    // Default 1 MB is plenty for every route except PATCH /auth/me (which
    // accepts a ~600 KB base64 avatar). That route opts into a larger
    // bodyLimit locally. Keeping the global cap low limits DoS amplification:
    // 200 req/min × 1 MB is bounded, vs 200 × 10 MB which was 2 GB/min/IP.
    bodyLimit: 1 * 1024 * 1024,
    // When TRUST_PROXY=true, Fastify reads X-Forwarded-For so per-IP rate
    // limits don't lump every request behind the proxy onto one bucket.
    trustProxy: env.trustProxy,
    // Fastify v5 defaults to removeAdditional: 'all', which silently strips
    // unknown body fields. That hides client typos and turns schema diffs into
    // soft failures instead of 400s. We want strict validation everywhere.
    ajv: { customOptions: { removeAdditional: false } },
    logger: {
      level: isProd ? 'info' : 'debug',
      transport: isProd
        ? undefined
        : {
            target: 'pino-pretty',
            options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
          },
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: isProd ? undefined : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // HSTS with preload + includeSubDomains pins clients to HTTPS for
    // two years and lets us submit the domain to the browser preload
    // list (hstspreload.org). max-age below 1 year disqualifies the
    // submission; 63072000 = 2 years is the recommended floor.
    hsts: isProd ? { maxAge: 63072000, includeSubDomains: true, preload: true } : false,
  });

  // CORS: in dev, allow no-origin (mobile/native) and any localhost.
  // In prod, only whitelisted origins from env.corsOrigins are allowed.
  //
  // The dev allowlist must close the host portion before "/" or ":" — a
  // naive prefix like "192.168." would also match "https://192.168.1evil.com".
  // The `(?::\d+)?` accepts an optional port and `(?:$|/)` requires the host
  // to actually end there.
  const DEV_HOST_RX =
    /^https?:\/\/(?:localhost|127\.0\.0\.1|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2})(?::\d+)?(?:$|\/)/;
  await app.register(cors, {
    credentials: true,
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allowed = env.corsOrigins;
      if (allowed.includes(origin)) return cb(null, true);
      if (!isProd && DEV_HOST_RX.test(origin)) {
        return cb(null, true);
      }
      return cb(new Error('cors_blocked'), false);
    },
  });

  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health',
  });

  await app.register(mongoPlugin);
  await app.register(authPlugin);
  if (env.enableSwagger) await app.register(swaggerPlugin);

  app.get(
    '/health',
    {
      schema: {
        tags: ['System'],
        summary: 'Health check',
        description: 'Liveness probe. Returns ok and a server timestamp.',
        response: {
          200: {
            type: 'object',
            required: ['ok', 'ts'],
            properties: {
              ok: { type: 'boolean', const: true },
              ts: { type: 'number', description: 'Server unix epoch ms.' },
            },
          },
        },
      },
    },
    async () => ({ ok: true, ts: Date.now() }),
  );

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(categoriesRoutes, { prefix: '/categories' });
  await app.register(walletsRoutes, { prefix: '/wallets' });
  await app.register(transactionsRoutes, { prefix: '/tx' });
  await app.register(debtsRoutes, { prefix: '/debts' });
  await app.register(budgetsRoutes, { prefix: '/budgets' });
  await app.register(recurringRoutes, { prefix: '/recurring' });
  await app.register(notificationsRoutes, { prefix: '/notifs' });

  app.setErrorHandler(
    (
      err: Error & { statusCode?: number; validation?: unknown; validationContext?: string },
      _req,
      reply,
    ) => {
      if (reply.sent) return;
      const status = err.statusCode ?? 500;
      if (status >= 500) {
        app.log.error(err);
        return reply.code(status).send({ error: 'internal_error' });
      }
      // Hide raw messages: only forward known short error codes (snake_case),
      // strip stack/details. Validation errors get a generic code in prod,
      // but include the structured details in non-prod so clients can debug
      // schema mismatches without trial-and-error.
      if (err.validation) {
        if (isProd) {
          return reply.code(status).send({ error: 'bad_request' });
        }
        return reply.code(status).send({
          error: 'bad_request',
          validation: err.validation,
          validationContext: err.validationContext,
        });
      }
      const safe = /[\s.<>:]/.test(err.message ?? '') ? 'bad_request' : err.message || 'error';
      return reply.code(status).send({ error: safe });
    },
  );

  return app;
};
