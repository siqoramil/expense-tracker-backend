import type { FastifyPluginAsync } from 'fastify';
import { Budget } from '../models/Budget.js';

const OBJECT_ID = '^[0-9a-fA-F]{24}$';

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', pattern: OBJECT_ID } },
  required: ['id'],
} as const;

const budgetsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get('/', async (req) => {
    const items = await Budget.find({ userId: req.user.sub }).sort({ createdAt: 1 });
    return { items };
  });

  app.post<{ Body: { cat: string; limit: number } }>(
    '/',
    {
      schema: {
        body: {
          type: 'object',
          required: ['cat', 'limit'],
          properties: {
            cat: { type: 'string', minLength: 1, maxLength: 80 },
            limit: { type: 'number', minimum: 0, maximum: 1e12 },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const budget = await Budget.create({ ...req.body, userId: req.user.sub });
      return { item: budget };
    },
  );

  app.patch<{ Params: { id: string }; Body: { limit?: number } }>(
    '/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          properties: { limit: { type: 'number', minimum: 0, maximum: 1e12 } },
          additionalProperties: false,
        },
      },
    },
    async (req, reply) => {
      const budget = await Budget.findOneAndUpdate(
        { _id: req.params.id, userId: req.user.sub },
        req.body,
        { new: true },
      );
      if (!budget) return reply.code(404).send({ error: 'not_found' });
      return { item: budget };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    { schema: { params: idParams } },
    async (req, reply) => {
      const res = await Budget.deleteOne({ _id: req.params.id, userId: req.user.sub });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
};

export default budgetsRoutes;
