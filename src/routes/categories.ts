import type { FastifyPluginAsync } from 'fastify';
import { seedDefaultCategories } from '../lib/defaultCategories.js';
import {
  categoryEntity,
  errorResponseWith,
  idParams,
  itemResponse,
  itemsResponse,
  okResponse,
} from '../lib/schemas.js';
import { Category } from '../models/Category.js';

const labelSchema = {
  type: 'object',
  required: ['en', 'uz'],
  properties: {
    en: { type: 'string', minLength: 1, maxLength: 80, description: 'English label.', example: 'Food' },
    uz: { type: 'string', minLength: 1, maxLength: 80, description: 'Uzbek label.', example: 'Oziq-ovqat' },
  },
  additionalProperties: false,
} as const;

const categoryBody = {
  type: 'object',
  required: ['label', 'icon', 'color', 'kind'],
  properties: {
    label: labelSchema,
    icon: {
      type: 'string',
      minLength: 1,
      maxLength: 40,
      description: 'Icon identifier slug used by the mobile app.',
      example: 'food',
    },
    color: {
      type: 'string',
      minLength: 1,
      maxLength: 40,
      description: 'Hex color string for the category chip.',
      example: '#FF6B6B',
    },
    kind: {
      type: 'string',
      enum: ['income', 'expense'],
      description: 'Whether this category is for income or expense transactions.',
      example: 'expense',
    },
  },
  additionalProperties: false,
} as const;

const categoryPatchBody = {
  type: 'object',
  properties: {
    label: labelSchema,
    icon: {
      type: 'string',
      minLength: 1,
      maxLength: 40,
      description: 'Icon identifier slug.',
      example: 'food',
    },
    color: {
      type: 'string',
      minLength: 1,
      maxLength: 40,
      description: 'Hex color string.',
      example: '#FF6B6B',
    },
    kind: {
      type: 'string',
      enum: ['income', 'expense'],
      description: 'Whether this category is for income or expense.',
      example: 'expense',
    },
  },
  additionalProperties: false,
} as const;

const categoriesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get(
    '/',
    {
      schema: {
        tags: ['Categories'],
        summary: 'List categories',
        description:
          'Returns all categories owned by the authenticated user, sorted by creation time. If the user has no categories yet (e.g. a newly seeded account), default categories are backfilled before returning.',
        response: {
          200: itemsResponse(categoryEntity),
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      const count = await Category.countDocuments({ userId: req.user.sub });
      if (count === 0) {
        // Backfill existing accounts that predate default-category seeding.
        // ordered:false in insertMany makes this race-tolerant (duplicate-key
        // errors on a concurrent seed are swallowed per-document).
        await seedDefaultCategories(req.user.sub).catch(() => {
          // Best-effort: a seed failure must not prevent the list from returning.
        });
      }
      const items = await Category.find({ userId: req.user.sub }).sort({ createdAt: 1 }).lean();
      return { items };
    },
  );

  app.post<{
    Body: {
      label: { en: string; uz: string };
      icon: string;
      color: string;
      kind: 'income' | 'expense';
    };
  }>(
    '/',
    {
      schema: {
        tags: ['Categories'],
        summary: 'Create category',
        description: 'Creates an income or expense category with a bilingual label, icon slug, and hex color.',
        body: categoryBody,
        response: {
          200: itemResponse(categoryEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      const cat = await Category.create({ ...req.body, userId: req.user.sub });
      return { item: cat };
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/:id',
    {
      schema: {
        tags: ['Categories'],
        summary: 'Update category',
        description: 'Patches one or more fields on an existing category owned by the user. Unknown fields are rejected.',
        params: idParams,
        body: categoryPatchBody,
        response: {
          200: itemResponse(categoryEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const cat = await Category.findOneAndUpdate(
        { _id: req.params.id, userId: req.user.sub },
        req.body,
        { new: true, lean: true },
      );
      if (!cat) return reply.code(404).send({ error: 'not_found' });
      return { item: cat };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['Categories'],
        summary: 'Delete category',
        description: 'Permanently deletes a category owned by the user.',
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
      const res = await Category.deleteOne({ _id: req.params.id, userId: req.user.sub });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
};

export default categoriesRoutes;
