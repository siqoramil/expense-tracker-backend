import bcrypt from 'bcryptjs';
import {
  ConflictError,
  LockedError,
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  isDuplicateKeyError,
} from '@/core';
import {
  DUMMY_PASSWORD_HASH,
  normalizeEmail,
  seedDefaultCategories,
  seedDefaultWallets,
} from '@/lib';
import type { User } from '@/models';
import { userRepository } from '@/repositories';
import { BCRYPT_ROUNDS } from './constants.js';
import { googleAudiences, googleClient, verifyGoogleIdToken } from './google.js';
import { checkPasswordAuth, initialsFrom } from './helpers.js';

type SeedErrorLogger = (err: unknown, label: string) => void;

// Returns the created user document. Throws ConflictError('email_taken') on
// duplicate email. Fires seed tasks as fire-and-forget; the log callback is
// provided by the route so app.log stays out of the service.
export const register = async (
  body: { email: string; password: string; name: string },
  onSeedError: SeedErrorLogger,
) => {
  const email = normalizeEmail(body.email);
  const passwordHash = await bcrypt.hash(body.password, BCRYPT_ROUNDS);
  const avatar = initialsFrom(body.name);
  let user: InstanceType<typeof User>;
  try {
    user = await userRepository.create({
      email,
      passwordHash,
      name: body.name,
      avatar,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) throw new ConflictError('email_taken');
    throw err;
  }
  seedDefaultCategories(user._id).catch((err) =>
    onSeedError(err, 'seedDefaultCategories failed on register'),
  );
  seedDefaultWallets(user._id).catch((err) =>
    onSeedError(err, 'seedDefaultWallets failed on register'),
  );
  return user;
};

// Returns the authenticated user document. Route signs the JWT.
export const login = async (body: { email: string; password: string }) => {
  const email = normalizeEmail(body.email);
  const user = await userRepository.findByEmail(email);

  const isPasswordAccount = Boolean(user?.passwordHash);
  if (!user || !isPasswordAccount) {
    // Always run bcrypt against a dummy hash so "unknown email" and "wrong
    // password" take the same wall-clock time -- a 20x timing gap would
    // otherwise enumerate registered emails.
    await bcrypt.compare(body.password, DUMMY_PASSWORD_HASH);
    throw new UnauthorizedError('invalid_credentials');
  }

  const result = await checkPasswordAuth(user, body.password);
  await userRepository.save(user);

  if (result === 'locked') throw new LockedError('account_locked');
  if (result === 'invalid') throw new UnauthorizedError('invalid_credentials');

  return user;
};

// Verifies a Google ID token. Returns { user, isNew } where isNew signals
// the route to fire seed tasks. Throws appropriate AppErrors on failure.
export const googleSignIn = async (
  idToken: string,
  onSeedError: SeedErrorLogger,
): Promise<{ user: InstanceType<typeof User>; isNew: boolean }> => {
  const payload = await verifyGoogleIdToken(idToken);
  if (!payload.email || !payload.sub) {
    throw new UnauthorizedError('invalid_google_token');
  }
  if (payload.email_verified === false) {
    throw new UnauthorizedError('email_not_verified');
  }

  const email = normalizeEmail(payload.email);
  const name = payload.name || payload.given_name || email.split('@')[0];
  const picture = payload.picture ?? '';

  // Look up by googleId only. Auto-linking by email is an account-takeover
  // vector: if user A registered "victim@x.com" with a password (without
  // owning the inbox), the real Google owner could sign in and silently take
  // over. Linking now requires an explicit step at /auth/google/link.
  let user = await userRepository.findByGoogleId(payload.sub);
  let isNew = false;
  if (!user) {
    const collision = await userRepository.findByEmail(email);
    if (collision) throw new ConflictError('account_link_required');
    try {
      user = await userRepository.create({
        email,
        name,
        googleId: payload.sub,
        avatar: picture || initialsFrom(name),
        passwordHash: '',
      });
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        // Race: another request created a same-email account between our
        // check and create. Fail closed and tell the client to link.
        throw new ConflictError('account_link_required');
      }
      throw err;
    }
    isNew = true;
    seedDefaultCategories(user._id).catch((err) =>
      onSeedError(err, 'seedDefaultCategories failed on google register'),
    );
    seedDefaultWallets(user._id).catch((err) =>
      onSeedError(err, 'seedDefaultWallets failed on google register'),
    );
  } else if (!user.avatar && picture) {
    user.avatar = picture;
    await userRepository.save(user);
  }

  return { user, isNew };
};

// Attaches a Google sub to the authenticated account. The token's email
// must match the account email (closes the cross-account link takeover).
export const linkGoogle = async (
  userId: string,
  idToken: string,
): Promise<InstanceType<typeof User>> => {
  if (!googleClient || googleAudiences.length === 0) {
    throw new ServiceUnavailableError('google_auth_disabled');
  }
  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError();

  const payload = await verifyGoogleIdToken(idToken);
  if (!payload.email || !payload.sub) {
    throw new UnauthorizedError('invalid_google_token');
  }
  if (payload.email_verified === false) {
    throw new UnauthorizedError('email_not_verified');
  }
  if (normalizeEmail(payload.email) !== user.email) {
    throw new ConflictError('email_mismatch');
  }
  const already = await userRepository.findByGoogleId(payload.sub);
  if (already && already.id !== user.id) {
    throw new ConflictError('google_account_in_use');
  }
  user.googleId = payload.sub;
  if (!user.avatar && payload.picture) user.avatar = payload.picture;
  try {
    await userRepository.save(user);
  } catch (err) {
    // Race: another request linked the same Google sub between the check above
    // and this write. The partial unique index on googleId rejects it.
    if (isDuplicateKeyError(err)) throw new ConflictError('google_account_in_use');
    throw err;
  }
  return user;
};
