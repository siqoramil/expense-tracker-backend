import type { FastifyPluginAsync } from 'fastify';
import { Category } from '../models/Category.js';

const categoriesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get('/', async (req) => {
    const items = await Category.find({ userId: req.user.sub }).sort({ createdAt: 1 });
    return { items };
  });

  app.post<{
    Body: {
      label: { en: string; uz: string };
      icon: string;
      color: string;
      kind: 'income' | 'expense';
    };
  }>('/', async (req) => {
    const cat = await Category.create({ ...req.body, userId: req.user.sub });
    return { item: cat };
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/:id', async (req, reply) => {
    const cat = await Category.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.sub },
      req.body,
      { new: true },
    );
    if (!cat) return reply.code(404).send({ error: 'not_found' });
    return { item: cat };
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const res = await Category.deleteOne({ _id: req.params.id, userId: req.user.sub });
    if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
};

export default categoriesRoutes;
