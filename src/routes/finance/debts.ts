import type { FastifyPluginAsync } from 'fastify';
import {
  debtEntity,
  errorResponseWith,
  idParams,
  itemResponse,
  itemsResponse,
  okResponse,
} from '@/lib/schemas';
import { debtService } from '@/services';

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
    direction: {
      type: 'string',
      enum: ['owe_me', 'i_owe'],
      description: '"owe_me" = someone owes the user; "i_owe" = user owes someone.',
      example: 'owe_me',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Name of the counterparty.',
      example: 'Alex',
    },
    color: {
      type: 'string',
      maxLength: 40,
      pattern: '^#[0-9a-fA-F]{3,8}$',
      description: 'Optional UI accent color for this debt card.',
      example: '#4ECDC4',
    },
    amount: {
      type: 'number',
      minimum: 0,
      maximum: 1e12,
      description: 'Total debt amount.',
      example: 200,
    },
    due: {
      type: 'string',
      pattern: '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
      description: 'Due date in YYYY-MM-DD format.',
      example: '2026-03-01',
    },
    note: {
      type: 'string',
      maxLength: 1000,
      description: 'Optional free-text note.',
      example: 'Borrowed for rent deposit',
    },
  },
  additionalProperties: false,
} as const;

const debtPatchBody = {
  type: 'object',
  properties: {
    direction: {
      type: 'string',
      enum: ['owe_me', 'i_owe'],
      description: '"owe_me" = someone owes the user; "i_owe" = user owes someone.',
      example: 'owe_me',
    },
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: 'Name of the counterparty.',
      example: 'Alex',
    },
    color: {
      type: 'string',
      maxLength: 40,
      description: 'UI accent color.',
      example: '#4ECDC4',
    },
    amount: {
      type: 'number',
      minimum: 0,
      maximum: 1e12,
      description: 'Total debt amount.',
      example: 200,
    },
    due: {
      type: 'string',
      pattern: '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
      description: 'Due date in YYYY-MM-DD.',
      example: '2026-03-01',
    },
    note: {
      type: 'string',
      maxLength: 1000,
      description: 'Optional free-text note.',
      example: 'Borrowed for rent deposit',
    },
  },
  additionalProperties: false,
} as const;

const paymentBody = {
  type: 'object',
  required: ['amount'],
  properties: {
    amount: {
      type: 'number',
      minimum: 0,
      maximum: 1e12,
      description:
        'Amount being paid. Automatically clamped to the remaining unpaid balance (amount - paid).',
      example: 50,
    },
    date: {
      type: 'string',
      pattern: '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$',
      description: 'Payment date in YYYY-MM-DD. Defaults to today when omitted.',
      example: '2026-01-20',
    },
  },
  additionalProperties: false,
} as const;

const debtsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get<{ Querystring: { archived?: string } }>(
    '/',
    {
      schema: {
        tags: ['Debts'],
        summary: 'List debts',
        description:
          "Returns the user's debts sorted by creation time (newest first). By default archived debts are excluded; pass archived=true to include them.",
        querystring: {
          type: 'object',
          properties: {
            archived: {
              type: 'string',
              enum: ['true', 'false'],
              description: 'When "true", include archived debts in the response. Default: false.',
              example: 'false',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: itemsResponse(debtEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => ({ items: await debtService.list(req.user.sub, req.query.archived === 'true') }),
  );

  app.post<{ Body: DebtBody }>(
    '/',
    {
      schema: {
        tags: ['Debts'],
        summary: 'Create debt',
        description:
          'Records a new debt. direction=owe_me means someone owes the user money; i_owe means the user owes someone else. The paid field starts at 0.',
        body: debtBody,
        response: {
          200: itemResponse(debtEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          409: errorResponseWith(['limit_reached']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => ({ item: await debtService.create(req.user.sub, req.body) }),
  );

  app.patch<{ Params: { id: string }; Body: Partial<DebtBody> }>(
    '/:id',
    {
      schema: {
        tags: ['Debts'],
        summary: 'Update debt',
        description: 'Patches one or more fields on an existing debt owned by the user.',
        params: idParams,
        body: debtPatchBody,
        response: {
          200: itemResponse(debtEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => ({ item: await debtService.update(req.user.sub, req.params.id, req.body) }),
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        tags: ['Debts'],
        summary: 'Delete debt',
        description: 'Permanently deletes a debt and its full payment history.',
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
      await debtService.remove(req.user.sub, req.params.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string }; Body: { amount: number; date?: string } }>(
    '/:id/payments',
    {
      schema: {
        tags: ['Debts'],
        summary: 'Record debt payment',
        description:
          'Adds a payment toward the debt. The submitted amount is automatically clamped to the remaining unpaid balance (amount - paid). Returns 400 invalid_amount when the debt is already fully paid.',
        params: idParams,
        body: paymentBody,
        response: {
          200: itemResponse(debtEntity),
          400: errorResponseWith(['bad_request', 'invalid_amount']),
          409: errorResponseWith(['too_many_payments']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => ({
      item: await debtService.addPayment(
        req.user.sub,
        req.params.id,
        req.body.amount,
        req.body.date,
      ),
    }),
  );

  app.post<{ Params: { id: string } }>(
    '/:id/archive',
    {
      schema: {
        tags: ['Debts'],
        summary: 'Archive debt',
        description:
          'Marks a debt as archived and forces paid to equal amount (treating it as fully settled). Archived debts are excluded from GET /debts unless archived=true is passed.',
        params: idParams,
        response: {
          200: itemResponse(debtEntity),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => ({ item: await debtService.archive(req.user.sub, req.params.id) }),
  );
};

export default debtsRoutes;
