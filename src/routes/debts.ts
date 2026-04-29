import type { FastifyPluginAsync } from 'fastify';
import { Debt } from '../models/Debt.js';

type DebtBody = {
  direction: 'owe_me' | 'i_owe';
  name: string;
  color?: string;
  amount: number;
  due: string;
  note?: string;
};

const debtsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get<{ Querystring: { archived?: string } }>('/', async (req) => {
    const filter: Record<string, unknown> = { userId: req.user.sub };
    if (req.query.archived !== 'true') filter.archived = { $ne: true };
    const items = await Debt.find(filter).sort({ createdAt: -1 });
    return { items };
  });

  app.post<{ Body: DebtBody }>('/', async (req) => {
    const debt = await Debt.create({ ...req.body, userId: req.user.sub, paid: 0, payments: [] });
    return { item: debt };
  });

  app.patch<{ Params: { id: string }; Body: Partial<DebtBody> }>('/:id', async (req, reply) => {
    const debt = await Debt.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.sub },
      req.body,
      { new: true },
    );
    if (!debt) return reply.code(404).send({ error: 'not_found' });
    return { item: debt };
  });

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const res = await Debt.deleteOne({ _id: req.params.id, userId: req.user.sub });
    if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { amount: number; date?: string } }>(
    '/:id/payments',
    async (req, reply) => {
      const debt = await Debt.findOne({ _id: req.params.id, userId: req.user.sub });
      if (!debt) return reply.code(404).send({ error: 'not_found' });
      const amount = Math.min(req.body.amount, debt.amount - debt.paid);
      if (amount <= 0) return reply.code(400).send({ error: 'invalid_amount' });
      const date = req.body.date ?? new Date().toISOString().slice(0, 10);
      debt.payments.push({ amount, date });
      debt.paid += amount;
      await debt.save();
      return { item: debt };
    },
  );

  app.post<{ Params: { id: string } }>('/:id/archive', async (req, reply) => {
    const debt = await Debt.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.sub },
      { archived: true, $set: { paid: 0 } },
      { new: true },
    );
    if (!debt) return reply.code(404).send({ error: 'not_found' });
    debt.paid = debt.amount;
    await debt.save();
    return { item: debt };
  });
};

export default debtsRoutes;
