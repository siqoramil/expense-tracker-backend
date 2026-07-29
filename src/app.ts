import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { default as Ajv } from 'ajv';
import Fastify from 'fastify';
import { AppError } from '@/core';
import { env } from '@/lib';
import { authPlugin, mongoPlugin, swaggerPlugin } from '@/plugins';
import {
  authRoutes,
  budgetsRoutes,
  categoriesRoutes,
  debtsRoutes,
  notificationsRoutes,
  recurringRoutes,
  transactionsRoutes,
  walletsRoutes,
} from '@/routes';

export const buildApp = async () => {
  const isProd = env.nodeEnv === 'production';
  const app = Fastify({
    // Default 1 MB is plenty for every route except PATCH /auth/me (which
    // accepts a ~600 KB base64 avatar). That route opts into a larger
    // bodyLimit locally. Keeping the global cap low limits DoS amplification:
    // 200 req/min × 1 MB is bounded, vs 200 × 10 MB which was 2 GB/min/IP.
    bodyLimit: 1 * 1024 * 1024,
    // Close slowloris-style holds: drop a connection that hasn't completed its
    // request within these windows. Caddy fronts us, but defence-in-depth.
    // connectionTimeout caps an idle/half-open socket; requestTimeout caps the
    // time to receive a full request once bytes start arriving.
    connectionTimeout: 10_000,
    requestTimeout: 30_000,
    // When TRUST_PROXY=true, Fastify reads X-Forwarded-For so per-IP rate
    // limits don't lump every request behind the proxy onto one bucket.
    trustProxy: env.trustProxy,
    // Fastify v5 defaults to removeAdditional: 'all', which silently strips
    // unknown body fields. That hides client typos and turns schema diffs into
    // soft failures instead of 400s. We want strict validation everywhere.
    //
    // `example` is an OpenAPI annotation keyword (used throughout the route
    // schemas for Swagger docs); register it as a no-op so AJV's strict mode
    // doesn't reject schemas that carry it.
    ajv: {
      customOptions: { removeAdditional: false },
      plugins: [(ajv: Ajv) => ajv.addKeyword('example')],
    },
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

  // Production always runs behind a TLS-terminating proxy (see
  // docker-compose.yml: the app port is published on 127.0.0.1 only). If
  // TRUST_PROXY is not set there, every request is keyed to the proxy's single
  // IP and the per-IP limits above become server-wide — one abusive client
  // exhausts the quota for everyone. Loud on boot rather than silent at 3am.
  if (isProd && !env.trustProxy) {
    app.log.warn(
      'TRUST_PROXY is false in production: rate limits will bucket every ' +
        'client onto the proxy IP. Set TRUST_PROXY=true when behind a reverse proxy.',
    );
  }

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

  // The error handler MUST be registered before the route plugins so it is
  // inherited by their encapsulated contexts. Registered after, it never runs
  // for errors thrown inside those routes (services throw typed AppErrors).
  app.setErrorHandler(
    (
      err: Error & { statusCode?: number; validation?: unknown; validationContext?: string },
      _req,
      reply,
    ) => {
      if (reply.sent) return;
      // Typed application errors thrown by the service layer carry their own
      // status code and snake_case error code.
      if (err instanceof AppError) {
        return reply.code(err.statusCode).send({ error: err.code });
      }
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

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(categoriesRoutes, { prefix: '/categories' });
  await app.register(walletsRoutes, { prefix: '/wallets' });
  await app.register(transactionsRoutes, { prefix: '/tx' });
  await app.register(debtsRoutes, { prefix: '/debts' });
  await app.register(budgetsRoutes, { prefix: '/budgets' });
  await app.register(recurringRoutes, { prefix: '/recurring' });
  await app.register(notificationsRoutes, { prefix: '/notifs' });

  return app;
};
