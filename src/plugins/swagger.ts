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

const swaggerPlugin = async (app: FastifyInstance) => {
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Expense Tracker API',
        description: 'REST API for the Expense Tracker mobile app.',
        version: '1.0.0',
      },
      servers: [{ url: '/' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
    },
    transform: ({ schema, url }) => {
      const next = { ...(schema ?? {}) } as Record<string, unknown>;
      if (!next.tags) next.tags = [tagFromUrl(url)];
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
