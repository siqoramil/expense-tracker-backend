import type { FastifyPluginAsync } from 'fastify';
import {
  errorResponse,
  idParams,
  itemResponse,
  itemsResponse,
  okResponse,
  walletEntity,
} from '../lib/schemas.js';
import { Wallet } from '../models/Wallet.js';

const walletShape = {
  type: 'object',
  properties: {
    name: {
      type: 'object',
      properties: {
        en: { type: 'string', maxLength: 80 },
        uz: { type: 'string', maxLength: 80 },
      },
      additionalProperties: false,
    },
    icon: { type: 'string', maxLength: 40 },
    color: { type: 'string', maxLength: 40 },
    balance: { type: 'number', minimum: -1e12, maximum: 1e12 },
  },
  additionalProperties: false,
} as const;

type WalletBody = {
  name?: { en: string; uz: string };
  icon?: string;
  color?: string;
  balance?: number;
};

const walletsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get(
    '/',
    {
      schema: {
        summary: 'List wallets',
        description:
          "Returns every wallet owned by the authenticated user, in creation order.",
        response: {
          200: itemsResponse(walletEntity),
          401: errorResponse,
        },
      },
    },
    async (req) => {
      const items = await Wallet.find({ userId: req.user.sub }).sort({ createdAt: 1 });
      return { items };
    },
  );

  app.post<{ Body: WalletBody }>(
    '/',
    {
      schema: {
        summary: 'Create wallet',
        description:
          'Creates a new wallet (cash, card, etc.) with bilingual name, icon, and color.',
        body: { ...walletShape, required: ['name', 'icon', 'color'] },
        response: {
          200: itemResponse(walletEntity),
          400: errorResponse,
          401: errorResponse,
        },
      },
    },
    async (req) => {
      const wallet = await Wallet.create({ ...req.body, userId: req.user.sub });
      return { item: wallet };
    },
  );

  app.patch<{ Params: { id: string }; Body: WalletBody }>(
    '/:id',
    {
      schema: {
        summary: 'Update wallet',
        description:
          'Patches one or more fields on an existing wallet. The balance can be set directly here; transactions will continue to mutate it.',
        params: idParams,
        body: walletShape,
        response: {
          200: itemResponse(walletEntity),
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const wallet = await Wallet.findOneAndUpdate(
        { _id: req.params.id, userId: req.user.sub },
        req.body,
        { new: true },
      );
      if (!wallet) return reply.code(404).send({ error: 'not_found' });
      return { item: wallet };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/:id',
    {
      schema: {
        summary: 'Delete wallet',
        description:
          "Permanently deletes a wallet. Transactions that referenced this wallet keep their reference but the wallet record is gone.",
        params: idParams,
        response: {
          200: okResponse,
          401: errorResponse,
          404: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const res = await Wallet.deleteOne({ _id: req.params.id, userId: req.user.sub });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
};

export default walletsRoutes;
