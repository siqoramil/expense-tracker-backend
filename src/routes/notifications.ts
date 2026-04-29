import type { FastifyPluginAsync } from 'fastify';
import { Notification } from '../models/Notification.js';

const OBJECT_ID = '^[0-9a-fA-F]{24}$';

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', pattern: OBJECT_ID } },
  required: ['id'],
} as const;

type NotifBody = {
  title: string;
  body?: string;
  kind?: string;
  date?: string;
};

const notificationsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get('/', async (req) => {
    const items = await Notification.find({ userId: req.user.sub }).sort({ date: -1 });
    return { items };
  });

  app.post<{ Body: NotifBody }>(
    '/',
    {
      schema: {
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
      },
    },
    async (req) => {
      const item = await Notification.create({ ...req.body, userId: req.user.sub });
      return { item };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/:id/read',
    { schema: { params: idParams } },
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

  app.post('/read-all', async (req) => {
    await Notification.updateMany({ userId: req.user.sub, read: false }, { read: true });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { schema: { params: idParams } },
    async (req, reply) => {
      const res = await Notification.deleteOne({ _id: req.params.id, userId: req.user.sub });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
};

export default notificationsRoutes;
