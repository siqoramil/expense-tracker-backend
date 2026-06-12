import type { FastifyPluginAsync } from 'fastify';
import {
  errorResponseWith,
  idParams,
  itemResponse,
  itemsResponse,
  okResponse,
  walletEntity,
} from '../lib/schemas.js';
import { seedDefaultWallets } from '../lib/defaultWallets.js';
import { Transaction } from '../models/Transaction.js';
import { Wallet } from '../models/Wallet.js';

// POST accepts an initial `balance` to seed a wallet on creation. PATCH
// deliberately omits it: ongoing balance changes must flow through /tx so
// the wallet balance always reconciles with the sum of its transactions.
// Allowing PATCH to set balance directly let clients drift the two apart.
// Per-user document cap (abuse / storage-exhaustion guard).
const MAX_WALLETS = 100;

const walletCreateShape = {
  type: 'object',
  properties: {
    name: {
      type: 'object',
      properties: {
        en: { type: 'string', maxLength: 80, description: 'Wallet name in English.', example: 'Cash' },
        uz: { type: 'string', maxLength: 80, description: 'Wallet name in Uzbek.', example: 'Naqd pul' },
      },
      additionalProperties: false,
    },
    icon: {
      type: 'string',
      maxLength: 40,
      pattern: '^[a-z0-9_-]{1,40}$',
      description: 'Icon slug (lowercase alphanumeric, hyphens, underscores).',
      example: 'wallet',
    },
    color: {
      type: 'string',
      maxLength: 40,
      pattern: '^#[0-9a-fA-F]{3,8}$',
      description: 'Hex color string including the leading #.',
      example: '#2ECC71',
    },
    balance: {
      type: 'number',
      minimum: -1e12,
      maximum: 1e12,
      description: 'Initial balance to seed the wallet. After creation balance is managed via /tx.',
      example: 500,
    },
  },
  additionalProperties: false,
} as const;

const walletPatchShape = {
  type: 'object',
  properties: {
    name: {
      type: 'object',
      properties: {
        en: { type: 'string', maxLength: 80, description: 'Wallet name in English.', example: 'Cash' },
        uz: { type: 'string', maxLength: 80, description: 'Wallet name in Uzbek.', example: 'Naqd pul' },
      },
      additionalProperties: false,
    },
    icon: {
      type: 'string',
      maxLength: 40,
      pattern: '^[a-z0-9_-]{1,40}$',
      description: 'Icon slug.',
      example: 'wallet',
    },
    color: {
      type: 'string',
      maxLength: 40,
      pattern: '^#[0-9a-fA-F]{3,8}$',
      description: 'Hex color string.',
      example: '#2ECC71',
    },
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
        tags: ['Wallets'],
        summary: 'List wallets',
        description: 'Returns every wallet owned by the authenticated user, sorted by creation time (oldest first).',
        response: {
          200: itemsResponse(walletEntity),
          401: errorResponseWith(['unauthorized']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      const count = await Wallet.countDocuments({ userId: req.user.sub });
      if (count === 0) {
        // Backfill existing accounts created before server-side wallet seeding.
        // ordered:false tolerates a concurrent seed (per-doc duplicate errors
        // are swallowed). Best-effort: a seed failure must not block the list.
        await seedDefaultWallets(req.user.sub).catch(() => {});
      }
      const items = await Wallet.find({ userId: req.user.sub }).sort({ createdAt: 1 }).lean();
      return { items };
    },
  );

  app.post<{ Body: WalletCreateBody }>(
    '/',
    {
      schema: {
        tags: ['Wallets'],
        summary: 'Create wallet',
        description:
          'Creates a new wallet (cash, card, crypto, etc.) with bilingual name, icon slug, and hex color. An initial balance may be seeded here; all subsequent balance changes must go through POST /tx.',
        body: { ...walletCreateShape, required: ['name', 'icon', 'color'] },
        response: {
          200: itemResponse(walletEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          409: errorResponseWith(['limit_reached']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      // Per-user cap: keep one account from creating unbounded documents.
      const count = await Wallet.countDocuments({ userId: req.user.sub });
      if (count >= MAX_WALLETS) return reply.code(409).send({ error: 'limit_reached' });
      const wallet = await Wallet.create({ ...req.body, userId: req.user.sub });
      return { item: wallet };
    },
  );

  app.patch<{ Params: { id: string }; Body: WalletPatchBody }>(
    '/:id',
    {
      schema: {
        tags: ['Wallets'],
        summary: 'Update wallet',
        description:
          'Patches the name, icon, or color on an existing wallet. The balance field is intentionally absent -- it is derived from transaction writes via /tx and must stay in sync.',
        params: idParams,
        body: walletPatchShape,
        response: {
          200: itemResponse(walletEntity),
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const wallet = await Wallet.findOneAndUpdate(
        { _id: req.params.id, userId: req.user.sub },
        // Wrap in $set so a body key like "$unset" can never be interpreted as
        // a Mongo update operator (defence-in-depth alongside the strict schema).
        { $set: req.body },
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
        tags: ['Wallets'],
        summary: 'Delete wallet',
        description:
          'Permanently deletes a wallet. Deletion is blocked while any transaction still references the wallet (409 wallet_not_empty), to prevent orphaned transactions.',
        params: idParams,
        response: {
          200: okResponse,
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          409: errorResponseWith(['wallet_not_empty']),
          500: errorResponseWith(['internal_error']),
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
