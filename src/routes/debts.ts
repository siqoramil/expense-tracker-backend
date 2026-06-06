import type { FastifyPluginAsync } from 'fastify';
import {
  debtEntity,
  errorResponse,
  idParams,
  itemResponse,
  itemsResponse,
  okResponse,
} from '../lib/schemas.js';
import { Debt } from '../models/Debt.js';

type DebtBody = {
  direction: 'owe_me' | 'i_owe';
  name: string;
  color?: string;
  amount: number;
  due: string;
  note?: string;
};

const debtBody = {
  type: 'object',
  required: ['direction', 'name', 'amount', 'due'],
  properties: {
    direction: { type: 'string', enum: ['owe_me', 'i_owe'] },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    color: { type: 'string', maxLength: 40 },
    amount: { type: 'number', minimum: 0, maximum: 1e12 },
    due: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' },
    note: { type: 'string', maxLength: 1000 },
  },
  additionalProperties: false,
} as const;

const debtPatchBody = {
  type: 'object',
  properties: {
    direction: { type: 'string', enum: ['owe_me', 'i_owe'] },
    name: { type: 'string', minLength: 1, maxLength: 120 },
    color: { type: 'string', maxLength: 40 },
    amount: { type: 'number', minimum: 0, maximum: 1e12 },
    due: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' },
    note: { type: 'string', maxLength: 1000 },
  },
  additionalProperties: false,
} as const;

const paymentBody = {
  type: 'object',
  required: ['amount'],
  properties: {
    amount: { type: 'number', minimum: 0, maximum: 1e12 },
    date: { type: 'string', pattern: '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' },
  },
  additionalProperties: false,
} as const;

const debtsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get<{ Querystring: { archived?: string } }>(
    '/',
    {
      schema: {
        summary: 'List debts',
        description:
          "Returns the user's debts. By default excludes archived ones; pass `archived=true` to include them.",
        querystring: {
          type: 'object',
          properties: {
            archived: {
              type: 'string',
              enum: ['true', 'false'],
              description: 'When "true", include archived debts.',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: itemsResponse(debtEntity),
          401: errorResponse,
        },
      },
    },
    async (req) => {
      const filter: Record<string, unknown> = { userId: req.user.sub };
      if (req.query.archived !== 'true') filter.archived = { $ne: true };
      const items = await Debt.find(filter).sort({ createdAt: -1 }).lean();
      return { items };
    },
  );

  app.post<{ Body: DebtBody }>(
    '/',
    {
      schema: {
        summary: 'Create debt',
        description:
          'Records a new debt. `direction=owe_me` means someone owes the user; `i_owe` means the user owes someone.',
        body: debtBody,
        response: {
          200: itemResponse(debtEntity),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (req) => {
      const debt = await Debt.create({ ...req.body, userId: req.user.sub, paid: 0, payments: [] });
      return { item: debt };
    },
  );

  app.patch<{ Params: { id: string }; Body: Partial<DebtBody> }>(
    '/:id',
    {
      schema: {
        summary: 'Update debt',
        description: 'Patches one or more fields on an existing debt.',
        params: idParams,
        body: debtPatchBody,
        response: {
          200: itemResponse(debtEntity),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const debt = await Debt.findOneAndUpdate(
        { _id: req.params.id, userId: req.user.sub },
        req.body,
        { new: true },
      );
      if (!debt) return reply.code(404).send({ error: 'not_found' });
      return { item: debt };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        summary: 'Delete debt',
        description: 'Permanently deletes a debt and its payment history.',
        params: idParams,
        response: {
          200: okResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const res = await Debt.deleteOne({ _id: req.params.id, userId: req.user.sub });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { amount: number; date?: string } }>(
    '/:id/payments',
    {
      schema: {
        summary: 'Record debt payment',
        description:
          'Adds a payment toward the debt. The amount is clamped to the remaining balance.',
        params: idParams,
        body: paymentBody,
        response: {
          200: itemResponse(debtEntity),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
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

  app.post<{ Params: { id: string } }>(
    '/:id/archive',
    {
      schema: {
        summary: 'Archive debt',
        description: 'Marks a debt as archived and forces paid = amount.',
        params: idParams,
        response: {
          200: itemResponse(debtEntity),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const debt = await Debt.findOneAndUpdate(
        { _id: req.params.id, userId: req.user.sub },
        { archived: true },
        { new: true },
      );
      if (!debt) return reply.code(404).send({ error: 'not_found' });
      debt.paid = debt.amount;
      await debt.save();
      return { item: debt };
    },
  );
};

export default debtsRoutes;
