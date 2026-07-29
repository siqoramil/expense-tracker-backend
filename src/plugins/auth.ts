import fastifyJwt from '@fastify/jwt';
import { type preHandlerHookHandler } from 'fastify';
import fp from 'fastify-plugin';
import { env } from '@/lib';

declare module 'fastify' {
  interface FastifyInstance {
    auth: preHandlerHookHandler;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    // `purpose` scopes tokens to one flow so a token minted for one can't be
    // replayed in another. Session tokens carry 'session'; single-use tokens
    // carry their own value (e.g. 'password_reset_verified'). The auth hook
    // below accepts only session tokens.
    // `pca` (passwordChangedAt) is epoch-seconds at sign time; lets the auth
    // hook enforce revocation without a Mongo lookup per request.
    payload: { sub: string; purpose?: string; pca?: number };
    // `iat`/`exp` are added by the signer; expose them so the auth hook can
    // enforce passwordChangedAt revocation.
    user: { sub: string; iat: number; exp: number; purpose?: string; pca?: number };
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

    // Token-type confinement. Single-use tokens minted for other flows (the
    // `password_reset_verified` token from /auth/password/verify-code) are
    // signed with the same secret, so they pass jwtVerify() here too — and
    // their `sub` is an email, not a user id. Only session tokens may
    // authenticate a request. `undefined` is still accepted so sessions issued
    // before `purpose` was stamped survive the rollout; drop that arm once
    // JWT_EXPIRES_IN has elapsed since deploy.
    if (req.user.purpose !== undefined && req.user.purpose !== 'session') {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    // Token-level revocation: reject tokens minted before the user's last
    // credential change. `pca` (passwordChangedAt epoch-seconds) is embedded
    // at sign time so no Mongo lookup is needed per request. Old tokens that
    // predate this claim treat missing pca as 0 (always-valid) to avoid
    // breaking existing sessions during the rollout.
    const changedSec = req.user.pca ?? 0;
    // 1s skew tolerance — JWT iat and DB write can land in the same second.
    if (req.user.iat + 1 < changedSec) {
      return reply.code(401).send({ error: 'token_revoked' });
    }
  });
});
