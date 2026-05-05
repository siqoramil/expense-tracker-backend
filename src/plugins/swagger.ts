import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';

const tagFromUrl = (url: string): string => {
  const seg = url.split('?')[0].split('/').filter(Boolean)[0];
  if (!seg) return 'default';
  const map: Record<string, string> = {
    auth: 'Auth',
    categories: 'Categories',
    wallets: 'Wallets',
    tx: 'Transactions',
    debts: 'Debts',
    budgets: 'Budgets',
    recurring: 'Recurring',
    notifs: 'Notifications',
    health: 'System',
  };
  return map[seg] ?? seg;
};

// Endpoints that do NOT require a bearer token. Anything not listed here
// gets `security: [{ bearerAuth: [] }]` injected automatically.
//
// Note: `/auth/google/link` is intentionally NOT here — linking a Google
// identity onto an account requires that you're already signed in with
// the password credential, which is what closes the auto-link takeover.
const PUBLIC_ROUTES: Record<string, ReadonlySet<string>> = {
  GET: new Set(['/health']),
  POST: new Set([
    '/auth/register',
    '/auth/login',
    '/auth/google',
    '/auth/password/forgot',
    '/auth/password/verify-code',
    '/auth/password/reset',
  ]),
};

const isPublic = (method: string, url: string): boolean =>
  PUBLIC_ROUTES[method.toUpperCase()]?.has(url) ?? false;

const swaggerPlugin = async (app: FastifyInstance) => {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Expense Tracker API',
        description:
          'REST API for the Expense Tracker mobile app.\n\n' +
          '**Auth model.** All routes outside the public auth surface require ' +
          '`Authorization: Bearer <jwt>`. Tokens are revoked when the user ' +
          'resets their password — any JWT issued before the reset returns ' +
          '`401 token_revoked`.\n\n' +
          '**Errors.** Failures use the shape `{ "error": "<snake_case_code>" }`. ' +
          'Schema-validation failures return `400 bad_request`; in non-production ' +
          'the response also includes a `validation` array with field-level ' +
          'detail to aid debugging.\n\n' +
          '**Rate limit.** 200 req/min per IP globally; credential-touching ' +
          'auth routes are tighter (5–10 req/min).',
        version: '1.1.0',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description:
              'JWT obtained from `/auth/register`, `/auth/login`, `/auth/google`, ' +
              'or `/auth/password/reset`. Tokens are HS256-signed and expire after ' +
              'JWT_EXPIRES_IN (default 7d).',
          },
        },
      },
      tags: [
        { name: 'Auth', description: 'Account, sessions, and credential management.' },
        { name: 'Categories', description: 'Spending / income categories.' },
        { name: 'Wallets', description: 'User wallets and balances.' },
        { name: 'Transactions', description: 'Income and expense entries.' },
        { name: 'Debts', description: 'Money owed to or by the user.' },
        { name: 'Budgets', description: 'Per-category spending limits.' },
        { name: 'Recurring', description: 'Scheduled recurring entries.' },
        { name: 'Notifications', description: 'In-app notifications.' },
        { name: 'System', description: 'Service health and meta endpoints.' },
      ],
    },
    transform: ({ schema, url, route }) => {
      const next: Record<string, unknown> = { ...(schema ?? {}) };
      if (!next.tags) next.tags = [tagFromUrl(url)];

      const methods = Array.isArray(route.method)
        ? route.method
        : [route.method];
      const allPublic = methods.every((m) => isPublic(String(m), url));
      if (!allPublic && !next.security) {
        next.security = [{ bearerAuth: [] }];
      }
      return { schema: next as typeof schema, url };
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
    },
    staticCSP: true,
  });
};

export default fp(swaggerPlugin, { name: 'swagger' });
