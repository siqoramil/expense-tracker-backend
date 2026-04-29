import type { FastifyPluginAsync } from 'fastify';
import mongoose from 'mongoose';
import { Transaction } from '../models/Transaction.js';
import { Wallet } from '../models/Wallet.js';

type TxBody = {
  kind: 'income' | 'expense';
  cat: string;
  wallet: string;
  amount: number;
  note?: string;
  date: string;
};

const MONTH_RX = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const DATE_RX = /^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
const OBJECT_ID_RX = /^[0-9a-fA-F]{24}$/;

const monthRange = (month: string): { gte: string; lt: string } => {
  const [y, m] = month.split('-').map(Number);
  const nextY = m === 12 ? y + 1 : y;
  const nextM = m === 12 ? 1 : m + 1;
  return {
    gte: `${y}-${String(m).padStart(2, '0')}-01`,
    lt: `${nextY}-${String(nextM).padStart(2, '0')}-01`,
  };
};

const delta = (kind: 'income' | 'expense', amount: number) =>
  kind === 'income' ? amount : -amount;

const txBodySchema = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['income', 'expense'] },
    cat: { type: 'string', minLength: 1, maxLength: 80 },
    wallet: { type: 'string', pattern: OBJECT_ID_RX.source },
    amount: { type: 'number', minimum: 0, maximum: 1e12 },
    note: { type: 'string', maxLength: 500 },
    date: { type: 'string', pattern: DATE_RX.source },
  },
  additionalProperties: false,
} as const;

const transactionsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get<{ Querystring: { month?: string; kind?: 'income' | 'expense' } }>(
    '/',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            month: { type: 'string', pattern: MONTH_RX.source },
            kind: { type: 'string', enum: ['income', 'expense'] },
          },
          additionalProperties: false,
        },
      },
    },
    async (req) => {
      const filter: Record<string, unknown> = { userId: req.user.sub };
      if (req.query.month) {
        const { gte, lt } = monthRange(req.query.month);
        filter.date = { $gte: gte, $lt: lt };
      }
      if (req.query.kind) filter.kind = req.query.kind;
      const items = await Transaction.find(filter).sort({ date: -1, createdAt: -1 });
      return { items };
    },
  );

  app.post<{ Body: TxBody }>(
    '/',
    {
      schema: {
        body: {
          ...txBodySchema,
          required: ['kind', 'cat', 'wallet', 'amount', 'date'],
        },
      },
    },
    async (req, reply) => {
    const session = await mongoose.startSession();
    try {
      let tx;
      await session.withTransaction(async () => {
        const wallet = await Wallet.findOne(
          { _id: req.body.wallet, userId: req.user.sub },
          null,
          { session },
        );
        if (!wallet) throw reply.code(404).send({ error: 'wallet_not_found' });
        wallet.balance += delta(req.body.kind, req.body.amount);
        await wallet.save({ session });
        const [created] = await Transaction.create(
          [{ ...req.body, userId: req.user.sub }],
          { session },
        );
        tx = created;
      });
      return { item: tx };
    } finally {
      await session.endSession();
    }
  });

  app.patch<{ Params: { id: string }; Body: Partial<TxBody> }>(
    '/:id',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: OBJECT_ID_RX.source } },
          required: ['id'],
        },
        body: txBodySchema,
      },
    },
    async (req, reply) => {
    const session = await mongoose.startSession();
    try {
      let updated;
      await session.withTransaction(async () => {
        const old = await Transaction.findOne(
          { _id: req.params.id, userId: req.user.sub },
          null,
          { session },
        );
        if (!old) throw reply.code(404).send({ error: 'not_found' });

        const next = { ...old.toObject(), ...req.body };

        // Reverse old wallet effect
        const oldWallet = await Wallet.findOne(
          { _id: old.wallet, userId: req.user.sub },
          null,
          { session },
        );
        if (oldWallet) {
          oldWallet.balance -= delta(old.kind, old.amount);
          await oldWallet.save({ session });
        }
        // Apply new wallet effect
        const newWallet = await Wallet.findOne(
          { _id: next.wallet, userId: req.user.sub },
          null,
          { session },
        );
        if (newWallet) {
          newWallet.balance += delta(next.kind, next.amount);
          await newWallet.save({ session });
        }

        Object.assign(old, req.body);
        await old.save({ session });
        updated = old;
      });
      return { item: updated };
    } finally {
      await session.endSession();
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: OBJECT_ID_RX.source } },
          required: ['id'],
        },
      },
    },
    async (req, reply) => {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const tx = await Transaction.findOne(
          { _id: req.params.id, userId: req.user.sub },
          null,
          { session },
        );
        if (!tx) throw reply.code(404).send({ error: 'not_found' });
        const wallet = await Wallet.findOne(
          { _id: tx.wallet, userId: req.user.sub },
          null,
          { session },
        );
        if (wallet) {
          wallet.balance -= delta(tx.kind, tx.amount);
          await wallet.save({ session });
        }
        await tx.deleteOne({ session });
      });
      return { ok: true };
    } finally {
      await session.endSession();
    }
  });

  app.get<{ Params: { month: string } }>(
    '/stats/:month',
    {
      schema: {
        params: {
          type: 'object',
          properties: { month: { type: 'string', pattern: MONTH_RX.source } },
          required: ['month'],
        },
      },
    },
    async (req) => {
      const { gte, lt } = monthRange(req.params.month);
      const items = await Transaction.find({
        userId: req.user.sub,
        date: { $gte: gte, $lt: lt },
      });
      const income = items.filter((x) => x.kind === 'income').reduce((a, x) => a + x.amount, 0);
      const expense = items.filter((x) => x.kind === 'expense').reduce((a, x) => a + x.amount, 0);
      return { income, expense, net: income - expense, count: items.length };
    },
  );
};

export default transactionsRoutes;
