import type { FastifyPluginAsync } from 'fastify';
import { withMaybeTransaction } from '../lib/db-tx.js';
import {
  errorResponse,
  itemResponse,
  itemsResponse,
  okResponse,
  transactionEntity,
} from '../lib/schemas.js';
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
    // cat is an ObjectId on the model (Schema.Types.ObjectId). Accepting
    // a free-form string here let arbitrary input slip through to
    // Mongoose, which then threw CastError → 500. Match the model so
    // bad input is rejected at the edge with 400.
    cat: { type: 'string', pattern: OBJECT_ID_RX.source },
    wallet: { type: 'string', pattern: OBJECT_ID_RX.source },
    amount: { type: 'number', minimum: 0, maximum: 1e12 },
    note: { type: 'string', maxLength: 500 },
    date: { type: 'string', pattern: DATE_RX.source },
  },
  additionalProperties: false,
} as const;

const statsResponse = {
  type: 'object',
  required: ['income', 'expense', 'net', 'count'],
  properties: {
    income: { type: 'number', description: 'Sum of income amounts.' },
    expense: { type: 'number', description: 'Sum of expense amounts.' },
    net: { type: 'number', description: 'income − expense.' },
    count: { type: 'integer', description: 'Total transactions in the month.' },
  },
} as const;

const transactionsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get<{ Querystring: { month?: string; kind?: 'income' | 'expense' } }>(
    '/',
    {
      schema: {
        summary: 'List transactions',
        description:
          'Returns the user\'s transactions, optionally filtered by month (YYYY-MM) and/or kind.',
        querystring: {
          type: 'object',
          properties: {
            month: {
              type: 'string',
              pattern: MONTH_RX.source,
              description: 'Filter to a single month (e.g. "2026-05").',
            },
            kind: { type: 'string', enum: ['income', 'expense'] },
          },
          additionalProperties: false,
        },
        response: {
          200: itemsResponse(transactionEntity),
          401: errorResponse,
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
        summary: 'Create transaction',
        description:
          'Creates a transaction and atomically updates the wallet balance.',
        body: {
          ...txBodySchema,
          required: ['kind', 'cat', 'wallet', 'amount', 'date'],
        },
        response: {
          200: itemResponse(transactionEntity),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const tx = await withMaybeTransaction(async (session) => {
        const wallet = await Wallet.findOne(
          { _id: req.body.wallet, userId: req.user.sub },
          null,
          { session },
        );
        if (!wallet) throw reply.code(404).send({ error: 'wallet_not_found' });
        wallet.balance += delta(req.body.kind, req.body.amount);
        await wallet.save({ session: session ?? undefined });
        const [created] = await Transaction.create(
          [{ ...req.body, userId: req.user.sub }],
          { session: session ?? undefined },
        );
        return created;
      });
      return { item: tx };
    });

  app.patch<{ Params: { id: string }; Body: Partial<TxBody> }>(
    '/:id',
    {
      schema: {
        summary: 'Update transaction',
        description:
          'Updates a transaction and atomically reverses the previous wallet effect before applying the new one.',
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: OBJECT_ID_RX.source } },
          required: ['id'],
        },
        body: txBodySchema,
        response: {
          200: itemResponse(transactionEntity),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const updated = await withMaybeTransaction(async (session) => {
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
          await oldWallet.save({ session: session ?? undefined });
        }
        // Apply new wallet effect
        const newWallet = await Wallet.findOne(
          { _id: next.wallet, userId: req.user.sub },
          null,
          { session },
        );
        if (newWallet) {
          newWallet.balance += delta(next.kind, next.amount);
          await newWallet.save({ session: session ?? undefined });
        }

        Object.assign(old, req.body);
        await old.save({ session: session ?? undefined });
        return old;
      });
      return { item: updated };
    });

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        summary: 'Delete transaction',
        description:
          'Deletes a transaction and atomically reverses its effect on the wallet balance.',
        params: {
          type: 'object',
          properties: { id: { type: 'string', pattern: OBJECT_ID_RX.source } },
          required: ['id'],
        },
        response: {
          200: okResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      await withMaybeTransaction(async (session) => {
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
          await wallet.save({ session: session ?? undefined });
        }
        await tx.deleteOne({ session: session ?? undefined });
      });
      return { ok: true };
    });

  app.get<{ Params: { month: string } }>(
    '/stats/:month',
    {
      schema: {
        summary: 'Monthly transaction stats',
        description: 'Aggregates income, expense, net, and count for the given month.',
        params: {
          type: 'object',
          properties: {
            month: {
              type: 'string',
              pattern: MONTH_RX.source,
              description: 'YYYY-MM',
            },
          },
          required: ['month'],
        },
        response: {
          200: statsResponse,
          401: errorResponse,
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
