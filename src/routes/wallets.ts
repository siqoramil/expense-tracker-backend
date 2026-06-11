import type { FastifyPluginAsync } from 'fastify';
import {
  errorResponse,
  idParams,
  itemResponse,
  itemsResponse,
  okResponse,
  walletEntity,
} from '../lib/schemas.js';
import { Transaction } from '../models/Transaction.js';
import { Wallet } from '../models/Wallet.js';

// POST accepts an initial `balance` to seed a wallet on creation. PATCH
// deliberately omits it: ongoing balance changes must flow through /tx so
// the wallet balance always reconciles with the sum of its transactions.
// Allowing PATCH to set balance directly let clients drift the two apart.
const walletCreateShape = {
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
    icon: { type: 'string', maxLength: 40, pattern: '^[a-z0-9_-]{1,40}$' },
    color: { type: 'string', maxLength: 40, pattern: '^#[0-9a-fA-F]{3,8}$' },
    balance: { type: 'number', minimum: -1e12, maximum: 1e12 },
  },
  additionalProperties: false,
} as const;

const walletPatchShape = {
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
    icon: { type: 'string', maxLength: 40, pattern: '^[a-z0-9_-]{1,40}$' },
    color: { type: 'string', maxLength: 40, pattern: '^#[0-9a-fA-F]{3,8}$' },
  },
  additionalProperties: false,
} as const;

type WalletCreateBody = {
  name?: { en: string; uz: string };
  icon?: string;
  color?: string;
  balance?: number;
};

type WalletPatchBody = {
  name?: { en: string; uz: string };
  icon?: string;
  color?: string;
};

const walletsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.auth);

  app.get(
    '/',
    {
      schema: {
        summary: 'List wallets',
        description: 'Returns every wallet owned by the authenticated user, in creation order.',
        response: {
          200: itemsResponse(walletEntity),
          401: errorResponse,
        },
      },
    },
    async (req) => {
      const items = await Wallet.find({ userId: req.user.sub }).sort({ createdAt: 1 }).lean();
      return { items };
    },
  );

  app.post<{ Body: WalletCreateBody }>(
    '/',
    {
      schema: {
        summary: 'Create wallet',
        description:
          'Creates a new wallet (cash, card, etc.) with bilingual name, icon, and color. An initial balance may be seeded here; subsequent changes must go through /tx.',
        body: { ...walletCreateShape, required: ['name', 'icon', 'color'] },
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

  app.patch<{ Params: { id: string }; Body: WalletPatchBody }>(
    '/:id',
    {
      schema: {
        summary: 'Update wallet',
        description:
          'Patches the name, icon, or color on an existing wallet. The balance is intentionally not accepted here — it is derived from /tx writes and must stay in sync.',
        params: idParams,
        body: walletPatchShape,
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
        { new: true, lean: true },
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
          'Permanently deletes a wallet. Deletion is blocked while any transaction still references the wallet, to avoid orphaned transactions.',
        params: idParams,
        response: {
          200: okResponse,
          401: errorResponse,
          404: errorResponse,
          409: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const txCount = await Transaction.countDocuments({
        wallet: req.params.id,
        userId: req.user.sub,
      });
      if (txCount > 0) return reply.code(409).send({ error: 'wallet_not_empty' });
      const res = await Wallet.deleteOne({ _id: req.params.id, userId: req.user.sub });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
};

export default walletsRoutes;
