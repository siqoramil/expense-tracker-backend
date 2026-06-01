import type { FastifyPluginAsync } from 'fastify';
import {
  errorResponse,
  idParams,
  itemResponse,
  itemsResponse,
  OBJECT_ID_PATTERN,
  okResponse,
  recurringEntity,
} from '../lib/schemas.js';
import { Recurring } from '../models/Recurring.js';

const recurringBody = {
  type: 'object',
  required: ['kind', 'cat', 'wallet', 'amount', 'nextDate'],
  properties: {
    kind: { type: 'string', enum: ['income', 'expense'] },
    cat: { type: 'string', pattern: OBJECT_ID_PATTERN },
    wallet: { type: 'string', pattern: OBJECT_ID_PATTERN },
    amount: { type: 'number', minimum: 0, maximum: 1e12 },
    note: { type: 'string', maxLength: 500 },
    every: { type: 'string', enum: ['month', 'week'] },
    nextDate: { type: 'string', maxLength: 32 },
    enabled: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

const recurringPatchBody = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['income', 'expense'] },
    cat: { type: 'string', pattern: OBJECT_ID_PATTERN },
    wallet: { type: 'string', pattern: OBJECT_ID_PATTERN },
    amount: { type: 'number', minimum: 0, maximum: 1e12 },
    note: { type: 'string', maxLength: 500 },
    every: { type: 'string', enum: ['month', 'week'] },
    nextDate: { type: 'string', maxLength: 32 },
    enabled: { type: 'boolean' },
  },
  additionalProperties: false,
} as const;

const recurringRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get(
    '/',
    {
      schema: {
        summary: 'List recurring entries',
        description: 'Returns all recurring entries for the user, sorted by next due date.',
        response: {
          200: itemsResponse(recurringEntity),
          401: errorResponse,
        },
      },
    },
    async (req) => {
      const items = await Recurring.find({ userId: req.user.sub }).sort({ nextDate: 1 }).lean();
      return { items };
    },
  );

  app.post(
    '/',
    {
      schema: {
        summary: 'Create recurring entry',
        description: 'Creates a recurring income or expense schedule.',
        body: recurringBody,
        response: {
          200: itemResponse(recurringEntity),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (req) => {
      const item = await Recurring.create({ ...(req.body as object), userId: req.user.sub });
      return { item };
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/:id',
    {
      schema: {
        summary: 'Update recurring entry',
        description: 'Patches one or more fields on an existing recurring entry.',
        params: idParams,
        body: recurringPatchBody,
        response: {
          200: itemResponse(recurringEntity),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const item = await Recurring.findOneAndUpdate(
        { _id: req.params.id, userId: req.user.sub },
        req.body,
        { new: true },
      );
      if (!item) return reply.code(404).send({ error: 'not_found' });
      return { item };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        summary: 'Delete recurring entry',
        description: 'Permanently deletes a recurring entry.',
        params: idParams,
        response: {
          200: okResponse,
          401: errorResponse,
          404: errorResponse,
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
