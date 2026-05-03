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

type NotifBody = {
  title: string;
  body?: string;
  kind?: string;
  date?: string;
};

const notificationsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get(
    '/',
    {
      schema: {
        summary: 'List notifications',
        description:
          "Returns all notifications for the authenticated user, newest first.",
        response: {
          200: itemsResponse(notificationEntity),
          401: errorResponse,
        },
      },
    },
    async (req) => {
      const items = await Notification.find({ userId: req.user.sub }).sort({ date: -1 });
      return { items };
    },
  );

  app.post<{ Body: NotifBody }>(
    '/',
    {
      schema: {
        summary: 'Create notification',
        description: 'Creates a new in-app notification record for the user.',
        body: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string', minLength: 1, maxLength: 200 },
            body: { type: 'string', maxLength: 1000 },
            kind: { type: 'string', maxLength: 40 },
            date: { type: 'string', format: 'date-time' },
          },
          additionalProperties: false,
        },
        response: {
          200: itemResponse(notificationEntity),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (req) => {
      const item = await Notification.create({ ...req.body, userId: req.user.sub });
      return { item };
    },
  );

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
        { new: true },
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
        description: "Marks every unread notification belonging to the user as read.",
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
