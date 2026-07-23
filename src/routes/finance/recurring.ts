import type { FastifyPluginAsync } from 'fastify';
import {
  OBJECT_ID_PATTERN,
  errorResponseWith,
  idParams,
  itemResponse,
  itemsResponse,
  okResponse,
  recurringEntity,
} from '@/lib/schemas';
import { recurringService } from '@/services';

type RecurringInput = {
  kind: 'income' | 'expense';
  cat: string;
  wallet: string;
  amount: number;
  note?: string;
  every?: 'month' | 'week';
  nextDate: string;
  enabled?: boolean;
};

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
        description:
          'Returns all recurring entries for the user, sorted by next due date ascending.',
        response: {
          200: itemsResponse(recurringEntity),
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => ({ items: await recurringService.list(req.user.sub) }),
  );

  app.post<{ Body: RecurringInput }>(
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
          409: errorResponseWith(['limit_reached']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => ({ item: await recurringService.create(req.user.sub, req.body) }),
  );

  app.patch<{ Params: { id: string }; Body: Partial<RecurringInput> }>(
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
    async (req) => ({ item: await recurringService.update(req.user.sub, req.params.id, req.body) }),
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['Recurring'],
        summary: 'Delete recurring entry',
        description:
          'Permanently deletes a recurring entry. In-flight scheduled transactions are not affected.',
        params: idParams,
        response: {
          200: okResponse,
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      await recurringService.remove(req.user.sub, req.params.id);
      return { ok: true };
    },
  );
};

export default recurringRoutes;
