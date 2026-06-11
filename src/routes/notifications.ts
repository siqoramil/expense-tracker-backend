import type { FastifyPluginAsync } from 'fastify';
import {
  errorResponse,
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
        summary: 'List notifications',
        description:
          'Returns notifications for the authenticated user, newest first. Supports limit/skip pagination (default limit: 100).',
        querystring: {
          type: 'object',
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
            skip: { type: 'integer', minimum: 0, default: 0 },
          },
          additionalProperties: false,
        },
        response: {
          200: itemsResponse(notificationEntity),
          401: errorResponse,
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
        summary: 'Mark notification as read',
        description: 'Marks a single notification as read.',
        params: idParams,
        response: {
          200: itemResponse(notificationEntity),
          401: errorResponse,
          404: errorResponse,
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
        summary: 'Mark all notifications as read',
        description: 'Marks every unread notification belonging to the user as read.',
        response: {
          200: okResponse,
          401: errorResponse,
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
        summary: 'Delete notification',
        description: 'Permanently deletes a notification.',
        params: idParams,
        response: {
          200: okResponse,
          401: errorResponse,
          404: errorResponse,
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
