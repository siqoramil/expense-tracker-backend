import type { FastifyPluginAsync } from 'fastify';
import {
  errorResponseWith,
  idParams,
  itemResponse,
  itemsResponse,
  OBJECT_ID_PATTERN,
  okResponse,
  recurringEntity,
} from '../lib/schemas.js';
import { Category } from '../models/Category.js';
import { Recurring } from '../models/Recurring.js';
import { Wallet } from '../models/Wallet.js';

const recurringBody = {
  type: 'object',
  required: ['kind', 'cat', 'wallet', 'amount', 'nextDate'],
  properties: {
    kind: {
      type: 'string',
      enum: ['income', 'expense'],
      description: 'Whether this recurring entry generates income or an expense.',
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
      description: 'Wallet ObjectId. Must be owned by the user.',
      example: '64a1f2e3b4c5d6e7f8a9b0c5',
    },
    amount: {
      type: 'number',
      minimum: 0,
      maximum: 1e12,
      description: 'Amount posted each time the schedule fires.',
      example: 30,
    },
    note: {
      type: 'string',
      maxLength: 500,
      description: 'Optional label or note.',
      example: 'Netflix subscription',
    },
    every: {
      type: 'string',
      enum: ['month', 'week'],
      description: 'Recurrence frequency. Defaults to "month" when omitted.',
      example: 'month',
    },
    nextDate: {
      type: 'string',
      maxLength: 32,
      description: 'Next scheduled fire date (YYYY-MM-DD).',
      example: '2026-02-01',
    },
    enabled: {
      type: 'boolean',
      description: 'Whether the schedule is active. Defaults to true.',
      example: true,
    },
  },
  additionalProperties: false,
} as const;

const recurringPatchBody = {
  type: 'object',
  properties: {
    kind: {
      type: 'string',
      enum: ['income', 'expense'],
      description: 'Income or expense.',
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
      description: 'Wallet ObjectId. Must be owned by the user.',
      example: '64a1f2e3b4c5d6e7f8a9b0c5',
    },
    amount: {
      type: 'number',
      minimum: 0,
      maximum: 1e12,
      description: 'Amount per occurrence.',
      example: 30,
    },
    note: {
      type: 'string',
      maxLength: 500,
      description: 'Optional label or note.',
      example: 'Netflix subscription',
    },
    every: {
      type: 'string',
      enum: ['month', 'week'],
      description: 'Recurrence frequency.',
      example: 'month',
    },
    nextDate: {
      type: 'string',
      maxLength: 32,
      description: 'Next scheduled fire date (YYYY-MM-DD).',
      example: '2026-02-01',
    },
    enabled: {
      type: 'boolean',
      description: 'Set to false to pause the schedule without deleting it.',
      example: true,
    },
  },
  additionalProperties: false,
} as const;

const recurringRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get(
    '/',
    {
      schema: {
        tags: ['Recurring'],
        summary: 'List recurring entries',
        description: 'Returns all recurring entries for the user, sorted by next due date ascending.',
        response: {
          200: itemsResponse(recurringEntity),
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      const items = await Recurring.find({ userId: req.user.sub }).sort({ nextDate: 1 }).limit(1000).lean();
      return { items };
    },
  );

  app.post(
    '/',
    {
      schema: {
        tags: ['Recurring'],
        summary: 'Create recurring entry',
        description:
          'Creates a recurring income or expense schedule. Both the referenced category and wallet must be owned by the user.',
        body: recurringBody,
        response: {
          200: itemResponse(recurringEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['category_not_found', 'wallet_not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { cat: string; wallet: string };
      const [catOk, walletOk] = await Promise.all([
        Category.exists({ _id: body.cat, userId: req.user.sub }),
        Wallet.exists({ _id: body.wallet, userId: req.user.sub }),
      ]);
      if (!catOk) return reply.code(404).send({ error: 'category_not_found' });
      if (!walletOk) return reply.code(404).send({ error: 'wallet_not_found' });
      const item = await Recurring.create({ ...(req.body as object), userId: req.user.sub });
      return { item };
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/:id',
    {
      schema: {
        tags: ['Recurring'],
        summary: 'Update recurring entry',
        description:
          'Patches one or more fields on an existing recurring entry. If cat or wallet are changed they must still be owned by the user.',
        params: idParams,
        body: recurringPatchBody,
        response: {
          200: itemResponse(recurringEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found', 'category_not_found', 'wallet_not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const body = req.body as { cat?: string; wallet?: string };
      if (body.cat !== undefined) {
        const catOk = await Category.exists({ _id: body.cat, userId: req.user.sub });
        if (!catOk) return reply.code(404).send({ error: 'category_not_found' });
      }
      if (body.wallet !== undefined) {
        const walletOk = await Wallet.exists({ _id: body.wallet, userId: req.user.sub });
        if (!walletOk) return reply.code(404).send({ error: 'wallet_not_found' });
      }
      const item = await Recurring.findOneAndUpdate(
        { _id: req.params.id, userId: req.user.sub },
        req.body,
        { new: true, lean: true },
      );
      if (!item) return reply.code(404).send({ error: 'not_found' });
      return { item };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['Recurring'],
        summary: 'Delete recurring entry',
        description: 'Permanently deletes a recurring entry. In-flight scheduled transactions are not affected.',
        params: idParams,
        response: {
          200: okResponse,
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const res = await Recurring.deleteOne({ _id: req.params.id, userId: req.user.sub });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
};

export default recurringRoutes;
