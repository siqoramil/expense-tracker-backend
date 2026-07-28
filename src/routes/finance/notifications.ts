import type { FastifyPluginAsync } from 'fastify';
import {
  errorResponseWith,
  idParams,
  itemResponse,
  itemsResponse,
  notificationEntity,
  okResponse,
} from '@/lib/schemas';
import { notificationService } from '@/services';

const notificationsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get<{ Querystring: { limit?: number; skip?: number } }>(
    '/',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'List notifications',
        description:
          'Returns notifications for the authenticated user, newest first. Supports limit/skip pagination. Default limit is 100, default skip is 0. Notifications are server-generated events (overdue debts, budget breaches, scheduled bills, recurring income) -- clients cannot create them directly.',
        querystring: {
          type: 'object',
          properties: {
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 500,
              default: 100,
              description: 'Maximum number of notifications to return. Default: 100.',
              example: 20,
            },
            skip: {
              type: 'integer',
              minimum: 0,
              // Mongo walks and discards every skipped document, so an
              // unbounded offset is a cheap way to make the server do
              // expensive work. Well past any real notification history.
              maximum: 10_000,
              default: 0,
              description:
                'Number of notifications to skip (offset-based pagination). Default: 0. Max: 10000.',
              example: 0,
            },
          },
          additionalProperties: false,
        },
        response: {
          200: itemsResponse(notificationEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => ({
      items: await notificationService.list(
        req.user.sub,
        req.query.limit ?? 100,
        req.query.skip ?? 0,
      ),
    }),
  );

  // POST / used to allow client-side creation of notifications. Removed:
  // notifications represent server-side events (overdue debts, budget
  // breaches, scheduled bills, recurring income) and must originate from
  // the server. Letting clients craft their own notifications would let
  // a compromised device fabricate alerts to social-engineer the user.

  app.post<{ Params: { id: string } }>(
    '/:id/read',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'Mark notification as read',
        description:
          'Sets read=true on a single notification owned by the user. Idempotent: calling it again on an already-read notification still returns 200.',
        params: idParams,
        response: {
          200: itemResponse(notificationEntity),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => ({ item: await notificationService.markRead(req.user.sub, req.params.id) }),
  );

  app.post(
    '/read-all',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'Mark all notifications as read',
        description:
          'Marks every unread notification belonging to the user as read in a single bulk write. Returns ok=true even when there were no unread notifications.',
        response: {
          200: okResponse,
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      await notificationService.markAllRead(req.user.sub);
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'Delete notification',
        description: 'Permanently deletes a single notification owned by the user.',
        params: idParams,
        response: {
          200: okResponse,
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      await notificationService.remove(req.user.sub, req.params.id);
      return { ok: true };
    },
  );
};

export default notificationsRoutes;
