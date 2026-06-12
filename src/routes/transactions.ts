import type { FastifyPluginAsync } from 'fastify';
import {
  errorResponseWith,
  itemResponse,
  itemsResponse,
  OBJECT_ID_PATTERN,
  okResponse,
  transactionEntity,
} from '../lib/schemas.js';
import { transactionService } from '../services/transactionService.js';

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

const txBodySchema = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['income', 'expense'],
      description: 'Whether this transaction is income or expense.',
      example: 'expense',
    },
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

const idParam = {
  type: 'object',
  properties: {
    id: {
      type: 'string',
      pattern: OBJECT_ID_PATTERN,
      description: '24-hex ObjectId of the transaction.',
      example: '64a1f2e3b4c5d6e7f8a9b0c6',
    },
  },
  required: ['id'],
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
    async (req) => ({
      items: await transactionService.list(req.user.sub, {
        month: req.query.month,
        kind: req.query.kind,
        limit: req.query.limit ?? 1000,
      }),
    }),
  );

  app.post<{ Body: TxBody }>(
    '/',
    {
      schema: {
        tags: ['Transactions'],
        summary: 'Create transaction',
        description:
          'Creates a transaction and atomically adjusts the wallet balance (income adds to balance, expense subtracts). Both the category and wallet must be owned by the authenticated user.',
        body: { ...txBodySchema, required: ['kind', 'cat', 'wallet', 'amount', 'date'] },
        response: {
          200: itemResponse(transactionEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['category_not_found', 'wallet_not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => ({ item: await transactionService.create(req.user.sub, req.body) }),
  );

  app.patch<{ Params: { id: string }; Body: Partial<TxBody> }>(
    '/:id',
    {
      schema: {
        tags: ['Transactions'],
        summary: 'Update transaction',
        description:
          'Updates a transaction and atomically reverses the previous wallet balance effect before applying the new one. Any changed category or wallet must be owned by the user.',
        params: idParam,
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
    async (req) => ({ item: await transactionService.update(req.user.sub, req.params.id, req.body) }),
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['Transactions'],
        summary: 'Delete transaction',
        description: 'Deletes a transaction and atomically reverses its effect on the wallet balance.',
        params: idParam,
        response: {
          200: okResponse,
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      await transactionService.remove(req.user.sub, req.params.id);
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
    async (req) => transactionService.statsForMonth(req.user.sub, req.params.month),
  );
};

export default transactionsRoutes;
