import type { FastifyPluginAsync } from 'fastify';
import { Recurring } from '../models/Recurring.js';

const recurringRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get('/', async (req) => {
    const items = await Recurring.find({ userId: req.user.sub }).sort({ nextDate: 1 });
    return { items };
  });

  app.post('/', async (req) => {
    const item = await Recurring.create({ ...(req.body as object), userId: req.user.sub });
    return { item };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/:id', async (req, reply) => {
    const item = await Recurring.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.sub },
      req.body,
      { new: true },
    );
    if (!item) return reply.code(404).send({ error: 'not_found' });
    return { item };
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const res = await Recurring.deleteOne({ _id: req.params.id, userId: req.user.sub });
    if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
};

export default recurringRoutes;
