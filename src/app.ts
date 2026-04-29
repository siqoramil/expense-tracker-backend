import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { env } from './lib/env.js';
import authPlugin from './plugins/auth.js';
import mongoPlugin from './plugins/mongo.js';
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
    bodyLimit: 10 * 1024 * 1024,
    logger: {
      level: isProd ? 'info' : 'debug',
      transport: isProd
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } },
    },
  });

  await app.register(helmet, {
    contentSecurityPolicy: isProd ? undefined : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });

  // CORS: in dev, allow no-origin (mobile/native) and any localhost.
  // In prod, only whitelisted origins from env.corsOrigins are allowed.
  await app.register(cors, {
    credentials: true,
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      const allowed = env.corsOrigins;
      if (allowed.includes(origin)) return cb(null, true);
      if (!isProd && /^https?:\/\/(localhost|127\.0\.0\.1|10\.|192\.168\.)/.test(origin)) {
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

  app.get('/health', async () => ({ ok: true, ts: Date.now() }));

  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(categoriesRoutes, { prefix: '/categories' });
  await app.register(walletsRoutes, { prefix: '/wallets' });
  await app.register(transactionsRoutes, { prefix: '/tx' });
  await app.register(debtsRoutes, { prefix: '/debts' });
  await app.register(budgetsRoutes, { prefix: '/budgets' });
  await app.register(recurringRoutes, { prefix: '/recurring' });
  await app.register(notificationsRoutes, { prefix: '/notifs' });

  app.setErrorHandler((err: Error & { statusCode?: number; validation?: unknown }, _req, reply) => {
    if (reply.sent) return;
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      app.log.error(err);
      return reply.code(status).send({ error: 'internal_error' });
    }
    // Hide raw messages: only forward known short error codes (snake_case),
    // strip stack/details. Validation errors get a generic code.
    const safe =
      err.validation || /[\s.<>:]/.test(err.message ?? '')
        ? 'bad_request'
        : err.message || 'error';
    return reply.code(status).send({ error: safe });
  });

  return app;
};
