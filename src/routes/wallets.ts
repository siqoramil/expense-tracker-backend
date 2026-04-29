import type { FastifyPluginAsync } from 'fastify';
import { Wallet } from '../models/Wallet.js';

const OBJECT_ID = '^[0-9a-fA-F]{24}$';

const idParams = {
  type: 'object',
  properties: { id: { type: 'string', pattern: OBJECT_ID } },
  required: ['id'],
} as const;

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

  app.get('/', async (req) => {
    const items = await Wallet.find({ userId: req.user.sub }).sort({ createdAt: 1 });
    return { items };
  });

  app.post<{ Body: WalletBody }>(
    '/',
    {
      schema: {
        body: { ...walletShape, required: ['name', 'icon', 'color'] },
      },
    },
    async (req) => {
      const wallet = await Wallet.create({ ...req.body, userId: req.user.sub });
      return { item: wallet };
    },
  );

  app.patch<{ Params: { id: string }; Body: WalletBody }>(
    '/:id',
    { schema: { params: idParams, body: walletShape } },
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
    { schema: { params: idParams } },
    async (req, reply) => {
      const res = await Wallet.deleteOne({ _id: req.params.id, userId: req.user.sub });
      if (res.deletedCount === 0) return reply.code(404).send({ error: 'not_found' });
      return { ok: true };
    },
  );
};

export default walletsRoutes;
