import fastifyJwt from '@fastify/jwt';
import { type preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { env } from '../lib/env.js';
import { User } from '../models/User.js';

declare module 'fastify' {
  interface FastifyInstance {
    auth: preHandlerHookHandler;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string };
    // `iat`/`exp` are added by the signer; expose them so the auth hook can
    // enforce passwordChangedAt revocation.
    user: { sub: string; iat: number; exp: number };
  }
}

export default fp(async (app) => {
  await app.register(fastifyJwt, {
    secret: env.jwtSecret,
    sign: { expiresIn: env.jwtExpiresIn },
  });

  app.decorate('auth', async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // Token-level revocation: reject tokens minted before the user's last
    // credential change. Cheap projection — only one indexed field.
    const user = await User.findById(req.user.sub).select('passwordChangedAt').lean();
    if (!user) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const changedSec = Math.floor((user.passwordChangedAt?.getTime() ?? 0) / 1000);
    // 1s skew tolerance — JWT iat and DB write can land in the same second.
    if (req.user.iat + 1 < changedSec) {
      return reply.code(401).send({ error: 'token_revoked' });
    }
  });
});
