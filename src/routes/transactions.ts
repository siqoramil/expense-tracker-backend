import type { FastifyPluginAsync } from 'fastify';
import { Types } from 'mongoose';
import { withMaybeTransaction } from '../lib/db-tx.js';
import {
  errorResponseWith,
  itemResponse,
  itemsResponse,
  OBJECT_ID_PATTERN,
  okResponse,
  transactionEntity,
} from '../lib/schemas.js';
import { Category } from '../models/Category.js';
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
    kind: {
      type: 'string',
      enum: ['income', 'expense'],
      description: 'Whether this transaction is income or expense.',
      example: 'expense',
    },
    // cat is an ObjectId on the model (Schema.Types.ObjectId). Accepting
    // a free-form string here let arbitrary input slip through to
    // Mongoose, which then threw CastError -> 500. Match the model so
    // bad input is rejected at the edge with 400.
    cat: {
      type: 'string',
      pattern: OBJECT_ID_PATTERN,
      description: 'Category ObjectId. Must be owned by the user.',
      example: '64a1f2e3b4c5d6e7f8a9b0c3',
    },
    wallet: {
      type: 'string',
      pattern: OBJECT_ID_PATTERN,
      description: 'Wallet ObjectId. Must be owned by the user. Balance is updated atomically.',
      example: '64a1f2e3b4c5d6e7f8a9b0c5',
    },
    amount: {
      type: 'number',
      minimum: 0,
      maximum: 1e12,
      description: 'Transaction amount (non-negative). For expenses, the wallet balance is decremented.',
      example: 12.5,
    },
    note: {
      type: 'string',
      maxLength: 500,
      description: 'Optional free-text note.',
      example: 'Lunch at cafe',
    },
    date: {
      type: 'string',
      pattern: DATE_RX.source,
      description: 'Transaction date in YYYY-MM-DD format.',
      example: '2026-01-15',
    },
  },
  additionalProperties: false,
} as const;

const statsResponse = {
  type: 'object',
  required: ['income', 'expense', 'net', 'count'],
  properties: {
    income: { type: 'number', description: 'Sum of all income transaction amounts in the month.', example: 3000 },
    expense: { type: 'number', description: 'Sum of all expense transaction amounts in the month.', example: 1200.5 },
    net: { type: 'number', description: 'income minus expense.', example: 1799.5 },
    count: { type: 'integer', description: 'Total number of transactions in the month.', example: 14 },
  },
} as const;

const transactionsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get<{ Querystring: { month?: string; kind?: 'income' | 'expense'; limit?: number } }>(
    '/',
    {
      schema: {
        tags: ['Transactions'],
        summary: 'List transactions',
        description:
          "Returns the user's transactions sorted by date descending (most recent first), optionally filtered by month (YYYY-MM) and/or kind. Default limit is 1000.",
        querystring: {
          type: 'object',
          properties: {
            month: {
              type: 'string',
              pattern: MONTH_RX.source,
              description: 'Filter to a single calendar month, e.g. "2026-05".',
              example: '2026-01',
            },
            kind: {
              type: 'string',
              enum: ['income', 'expense'],
              description: 'Filter to only income or only expense transactions.',
              example: 'expense',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 1000,
              default: 1000,
              description: 'Maximum number of results to return. Default: 1000.',
              example: 50,
            },
          },
          additionalProperties: false,
        },
        response: {
          200: itemsResponse(transactionEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
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
      const items = await Transaction.find(filter)
        .sort({ date: -1, createdAt: -1 })
        .limit(req.query.limit ?? 1000)
        .lean();
      return { items };
    },
  );

  app.post<{ Body: TxBody }>(
    '/',
    {
      schema: {
        tags: ['Transactions'],
        summary: 'Create transaction',
        description:
          'Creates a transaction and atomically adjusts the wallet balance (income adds to balance, expense subtracts). Both the category and wallet must be owned by the authenticated user.',
        body: {
          ...txBodySchema,
          required: ['kind', 'cat', 'wallet', 'amount', 'date'],
        },
        response: {
          200: itemResponse(transactionEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['category_not_found', 'wallet_not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const tx = await withMaybeTransaction(async (session) => {
        const catOk = await Category.exists({ _id: req.body.cat, userId: req.user.sub });
        if (!catOk) throw reply.code(404).send({ error: 'category_not_found' });
        const res = await Wallet.updateOne(
          { _id: req.body.wallet, userId: req.user.sub },
          { $inc: { balance: delta(req.body.kind, req.body.amount) } },
          { session: session ?? undefined },
        );
        if (res.matchedCount === 0) throw reply.code(404).send({ error: 'wallet_not_found' });
        const [created] = await Transaction.create([{ ...req.body, userId: req.user.sub }], {
          session: session ?? undefined,
        });
        return created;
      });
      return { item: tx };
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<TxBody> }>(
    '/:id',
    {
      schema: {
        tags: ['Transactions'],
        summary: 'Update transaction',
        description:
          'Updates a transaction and atomically reverses the previous wallet balance effect before applying the new one. Any changed category or wallet must be owned by the user.',
        params: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              pattern: OBJECT_ID_PATTERN,
              description: '24-hex ObjectId of the transaction to update.',
              example: '64a1f2e3b4c5d6e7f8a9b0c6',
            },
          },
          required: ['id'],
        },
        body: txBodySchema,
        response: {
          200: itemResponse(transactionEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found', 'category_not_found', 'wallet_not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const updated = await withMaybeTransaction(async (session) => {
        const old = await Transaction.findOne({ _id: req.params.id, userId: req.user.sub }, null, {
          session,
        });
        if (!old) throw reply.code(404).send({ error: 'not_found' });

        const next = { ...old.toObject(), ...req.body };

        // Run the category and wallet ownership checks in parallel -- both are
        // reads and are independent of each other.
        const [catOk, newWalletOk] = await Promise.all([
          req.body.cat
            ? Category.exists({ _id: req.body.cat, userId: req.user.sub })
            : Promise.resolve(true as unknown as { _id: unknown } | null),
          Wallet.findOne({ _id: next.wallet, userId: req.user.sub }, { _id: 1 }, { session }),
        ]);
        if (req.body.cat && !catOk) throw reply.code(404).send({ error: 'category_not_found' });
        // The target wallet must be owned before any balance is mutated, so a
        // failure here leaves no half-applied $inc behind.
        if (!newWalletOk) throw reply.code(404).send({ error: 'wallet_not_found' });

        // Reverse old wallet effect (may be missing if the wallet was deleted).
        await Wallet.updateOne(
          { _id: old.wallet, userId: req.user.sub },
          { $inc: { balance: -delta(old.kind, old.amount) } },
          { session: session ?? undefined },
        );
        // Apply new wallet effect.
        await Wallet.updateOne(
          { _id: next.wallet, userId: req.user.sub },
          { $inc: { balance: delta(next.kind, next.amount) } },
          { session: session ?? undefined },
        );

        Object.assign(old, req.body);
        await old.save({ session: session ?? undefined });
        return old;
      });
      return { item: updated };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['Transactions'],
        summary: 'Delete transaction',
        description:
          'Deletes a transaction and atomically reverses its effect on the wallet balance.',
        params: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              pattern: OBJECT_ID_PATTERN,
              description: '24-hex ObjectId of the transaction to delete.',
              example: '64a1f2e3b4c5d6e7f8a9b0c6',
            },
          },
          required: ['id'],
        },
        response: {
          200: okResponse,
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      await withMaybeTransaction(async (session) => {
        const tx = await Transaction.findOne({ _id: req.params.id, userId: req.user.sub }, null, {
          session,
        });
        if (!tx) throw reply.code(404).send({ error: 'not_found' });
        await Wallet.updateOne(
          { _id: tx.wallet, userId: req.user.sub },
          { $inc: { balance: -delta(tx.kind, tx.amount) } },
          { session: session ?? undefined },
        );
        await tx.deleteOne({ session: session ?? undefined });
      });
      return { ok: true };
    },
  );

  app.get<{ Params: { month: string } }>(
    '/stats/:month',
    {
      schema: {
        tags: ['Transactions'],
        summary: 'Monthly transaction stats',
        description:
          'Aggregates total income, total expense, net (income minus expense), and transaction count for the given calendar month. Returns zeros for all fields when the user has no transactions that month.',
        params: {
          type: 'object',
          properties: {
            month: {
              type: 'string',
              pattern: MONTH_RX.source,
              description: 'Calendar month in YYYY-MM format.',
              example: '2026-01',
            },
          },
          required: ['month'],
        },
        response: {
          200: statsResponse,
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      const { gte, lt } = monthRange(req.params.month);
      const grouped = await Transaction.aggregate<{
        _id: 'income' | 'expense';
        sum: number;
        count: number;
      }>([
        { $match: { userId: new Types.ObjectId(req.user.sub), date: { $gte: gte, $lt: lt } } },
        { $project: { _id: 0, kind: 1, amount: 1 } },
        { $group: { _id: '$kind', sum: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]);
      let income = 0;
      let expense = 0;
      let count = 0;
      for (const row of grouped) {
        count += row.count;
        if (row._id === 'income') income = row.sum;
        else if (row._id === 'expense') expense = row.sum;
      }
      return { income, expense, net: income - expense, count };
    },
  );
};

export default transactionsRoutes;
