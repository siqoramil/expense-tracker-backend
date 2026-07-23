import type { FastifyPluginAsync } from 'fastify';
import {
  categoryEntity,
  errorResponseWith,
  idParams,
  itemResponse,
  itemsResponse,
  okResponse,
} from '@/lib/schemas';
import { categoryService } from '@/services';

const labelSchema = {
  type: 'object',
  required: ['en', 'uz'],
  properties: {
    en: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
      description: 'English label.',
      example: 'Food',
    },
    uz: {
      type: 'string',
      minLength: 1,
      maxLength: 80,
      description: 'Uzbek label.',
      example: 'Oziq-ovqat',
    },
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
      maxLength: 40,
      pattern: '^[a-z0-9_-]{1,40}$',
      description: 'Icon identifier slug used by the mobile app.',
      example: 'food',
    },
    color: {
      type: 'string',
      maxLength: 40,
      pattern: '^#[0-9a-fA-F]{3,8}$',
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
    async (req) => ({ items: await categoryService.list(req.user.sub) }),
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
        description:
          'Creates an income or expense category with a bilingual label, icon slug, and hex color.',
        body: categoryBody,
        response: {
          200: itemResponse(categoryEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          409: errorResponseWith(['limit_reached']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => ({ item: await categoryService.create(req.user.sub, req.body) }),
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/:id',
    {
      schema: {
        tags: ['Categories'],
        summary: 'Update category',
        description:
          'Patches one or more fields on an existing category owned by the user. Unknown fields are rejected.',
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
    async (req) => ({ item: await categoryService.update(req.user.sub, req.params.id, req.body) }),
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
          409: errorResponseWith(['category_in_use']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      await categoryService.remove(req.user.sub, req.params.id);
      return { ok: true };
    },
  );
};

export default categoriesRoutes;
