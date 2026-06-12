import type { FastifyPluginAsync } from 'fastify';
import {
  OBJECT_ID_PATTERN,
  budgetEntity,
  errorResponseWith,
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
        tags: ['Budgets'],
        summary: 'List budgets',
        description: 'Returns all budgets owned by the authenticated user, sorted by creation time.',
        response: {
          200: itemsResponse(budgetEntity),
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
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
        tags: ['Budgets'],
        summary: 'Create budget',
        description:
          'Creates a per-category monthly spending limit. Each user can have at most one budget per category (409 budget_exists on duplicate). The referenced category must be owned by the user.',
        body: {
          type: 'object',
          required: ['cat', 'limit'],
          properties: {
            cat: {
              type: 'string',
              pattern: OBJECT_ID_PATTERN,
              description: 'Category ObjectId to attach the budget to. Must be owned by the user.',
              example: '64a1f2e3b4c5d6e7f8a9b0c3',
            },
            limit: {
              type: 'number',
              minimum: 0,
              maximum: 1e12,
              description: 'Monthly spending limit in the user preferred currency.',
              example: 500,
            },
          },
          additionalProperties: false,
        },
        response: {
          200: itemResponse(budgetEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['category_not_found']),
          409: errorResponseWith(['budget_exists']),
          500: errorResponseWith(['internal_error']),
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
        tags: ['Budgets'],
        summary: 'Update budget',
        description: 'Updates the spending limit on an existing budget.',
        params: idParams,
        body: {
          type: 'object',
          properties: {
            limit: {
              type: 'number',
              minimum: 0,
              maximum: 1e12,
              description: 'New monthly spending limit.',
              example: 750,
            },
          },
          additionalProperties: false,
        },
        response: {
          200: itemResponse(budgetEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
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
        tags: ['Budgets'],
        summary: 'Delete budget',
        description: 'Permanently deletes a budget owned by the user.',
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
      const res = await Budget.deleteOne({ _id: req.params.id, userId: req.user.sub });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
};

export default budgetsRoutes;
