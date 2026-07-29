import type { FastifyInstance } from 'fastify';
import type { User } from '@/models';

// At least 8 chars, must contain a letter and a digit.
export const PASSWORD_PATTERN = '^(?=.*[A-Za-z])(?=.*\\d).{8,128}$';

// Strict rate limits for credential-touching routes.
export const tightLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
export const codeLimit = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

export const toUserDTO = (u: InstanceType<typeof User>) => ({
  id: u.id as string,
  email: u.email,
  name: u.name,
  avatar: u.avatar,
  pro: u.pro,
  prefs: u.prefs,
  // Surfaces which credentials are configured so the client can pick the
  // right re-auth flow (password vs fresh Google ID token) on sensitive
  // actions like confirm-delete.
  hasPassword: Boolean(u.passwordHash),
  hasGoogle: Boolean(u.googleId),
});

// Signs a session JWT carrying `pca` (passwordChangedAt, seconds) so tokens
// issued before a credential change can be rejected, and `purpose: 'session'`
// so the auth hook can tell a session apart from a single-use flow token
// signed with the same secret.
export const sessionResponse = (app: FastifyInstance, user: InstanceType<typeof User>) => {
  const pca = Math.floor((user.passwordChangedAt?.getTime() ?? 0) / 1000);
  const token = app.jwt.sign({ sub: user.id as string, pca, purpose: 'session' });
  return { token, user: toUserDTO(user) };
};
