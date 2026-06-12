import type { FastifyPluginAsync } from 'fastify';
import {
  errorResponseWith,
  idParams,
  itemResponse,
  itemsResponse,
  notificationEntity,
  okResponse,
} from '../lib/schemas.js';
import { Notification } from '../models/Notification.js';

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
              default: 0,
              description: 'Number of notifications to skip (offset-based pagination). Default: 0.',
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
    async (req) => {
      const limit = req.query.limit ?? 100;
      const skip = req.query.skip ?? 0;
      const items = await Notification.find({ userId: req.user.sub })
        .sort({ date: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
      return { items };
    },
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
        description: 'Sets read=true on a single notification owned by the user. Idempotent: calling it again on an already-read notification still returns 200.',
        params: idParams,
        response: {
          200: itemResponse(notificationEntity),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const item = await Notification.findOneAndUpdate(
        { _id: req.params.id, userId: req.user.sub },
        { read: true },
        { new: true, lean: true },
      );
      if (!item) return reply.code(404).send({ error: 'not_found' });
      return { item };
    },
  );

  app.post(
    '/read-all',
    {
      schema: {
        tags: ['Notifications'],
        summary: 'Mark all notifications as read',
        description: 'Marks every unread notification belonging to the user as read in a single bulk write. Returns ok=true even when there were no unread notifications.',
        response: {
          200: okResponse,
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      await Notification.updateMany({ userId: req.user.sub, read: false }, { read: true });
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
    async (req, reply) => {
      const res = await Notification.deleteOne({ _id: req.params.id, userId: req.user.sub });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
};

export default notificationsRoutes;
