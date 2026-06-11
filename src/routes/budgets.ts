import type { FastifyPluginAsync } from 'fastify';
import {
  OBJECT_ID_PATTERN,
  budgetEntity,
  errorResponse,
  idParams,
  itemResponse,
  itemsResponse,
  okResponse,
} from '../lib/schemas.js';
import { Budget } from '../models/Budget.js';
import { Category } from '../models/Category.js';

const budgetsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get(
    '/',
    {
      schema: {
        summary: 'List budgets',
        description: 'Returns all budgets owned by the authenticated user.',
        response: {
          200: itemsResponse(budgetEntity),
          401: errorResponse,
        },
      },
    },
    async (req) => {
      const items = await Budget.find({ userId: req.user.sub }).sort({ createdAt: 1 }).lean();
      return { items };
    },
  );

  app.post<{ Body: { cat: string; limit: number } }>(
    '/',
    {
      schema: {
        summary: 'Create budget',
        description: 'Creates a per-category spending limit.',
        body: {
          type: 'object',
          required: ['cat', 'limit'],
          properties: {
            cat: { type: 'string', pattern: OBJECT_ID_PATTERN },
            limit: { type: 'number', minimum: 0, maximum: 1e12 },
          },
          additionalProperties: false,
        },
        response: {
          200: itemResponse(budgetEntity),
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const catOk = await Category.exists({ _id: req.body.cat, userId: req.user.sub });
      if (!catOk) return reply.code(404).send({ error: 'category_not_found' });
      try {
        const budget = await Budget.create({ ...req.body, userId: req.user.sub });
        return { item: budget };
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          return reply.code(409).send({ error: 'budget_exists' });
        }
        throw err;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: { limit?: number } }>(
    '/:id',
    {
      schema: {
        summary: 'Update budget',
        description: 'Updates the spending limit on an existing budget.',
        params: idParams,
        body: {
          type: 'object',
          properties: { limit: { type: 'number', minimum: 0, maximum: 1e12 } },
          additionalProperties: false,
        },
        response: {
          200: itemResponse(budgetEntity),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const budget = await Budget.findOneAndUpdate(
        { _id: req.params.id, userId: req.user.sub },
        req.body,
        { new: true, lean: true },
      );
      if (!budget) return reply.code(404).send({ error: 'not_found' });
      return { item: budget };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        summary: 'Delete budget',
        description: 'Permanently deletes a budget owned by the user.',
        params: idParams,
        response: {
          200: okResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const res = await Budget.deleteOne({ _id: req.params.id, userId: req.user.sub });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
};

export default budgetsRoutes;
