import bcrypt from 'bcryptjs';
import { OAuth2Client } from 'google-auth-library';
import {
  BadRequestError,
  ConflictError,
  LockedError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../core/errors.js';
import { isDuplicateKeyError } from '../core/mongoErrors.js';
import { withMaybeTransaction } from '../lib/db-tx.js';
import { seedDefaultCategories } from '../lib/defaultCategories.js';
import { seedDefaultWallets } from '../lib/defaultWallets.js';
import { env } from '../lib/env.js';
import { generateCode, sendVerificationCode } from '../lib/mailer.js';
import { normalizeEmail } from '../lib/normalize.js';
import { DUMMY_PASSWORD_HASH, safeCodeEqual } from '../lib/security.js';
import type { User } from '../models/User.js';
import type { VerificationCode } from '../models/VerificationCode.js';
import { budgetRepository } from '../repositories/budgetRepository.js';
import { categoryRepository } from '../repositories/categoryRepository.js';
import { debtRepository } from '../repositories/debtRepository.js';
import { notificationRepository } from '../repositories/notificationRepository.js';
import { recurringRepository } from '../repositories/recurringRepository.js';
import { transactionRepository } from '../repositories/transactionRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { verificationCodeRepository } from '../repositories/verificationCodeRepository.js';
import { walletRepository } from '../repositories/walletRepository.js';

// -- Constants ----------------------------------------------------------------

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const CODE_RESEND_COOLDOWN_MS = 60 * 1000;

const BCRYPT_ROUNDS = 12;

// Account-level brute-force lockout for /login.
const LOGIN_FAILURE_THRESHOLD = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

// Per-account brute-force lockout for password reset codes. Survives
// /password/forgot re-issuance so an attacker can't refresh their guess
// budget by requesting a new code.
const RESET_LOCKOUT_THRESHOLD = 5;
const RESET_LOCKOUT_MS = 15 * 60 * 1000;

export const VERIFIED_TOKEN_TTL = '2m';
export const CODE_TTL_SECONDS = CODE_TTL_MS / 1000;

// -- Google client (module-level, avoids Fastify coupling) -------------------

const googleAudiences = [
  env.google.webClientId,
  env.google.iosClientId,
  env.google.androidClientId,
].filter((id) => id.length > 0);

export const googleClient = googleAudiences.length > 0 ? new OAuth2Client() : null;
export { googleAudiences };

// -- Helpers ------------------------------------------------------------------

export const initialsFrom = (name: string) =>
  name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

// Checks lockout, compares password, and updates failure/lockout counters
// on the live document. Returns 'locked' | 'invalid' | 'ok'. Callers must
// save() the user after 'ok' or 'invalid' (the doc is mutated in-place).
const checkPasswordAuth = async (
  user: InstanceType<typeof User>,
  password: string,
): Promise<'locked' | 'invalid' | 'ok'> => {
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    // Equalize timing: run the same bcrypt work the non-locked path does so
    // a locked account is not measurably faster to probe (timing oracle).
    await bcrypt.compare(password, user.passwordHash);
    return 'locked';
  }
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) {
    user.failedLogins = (user.failedLogins ?? 0) + 1;
    if (user.failedLogins >= LOGIN_FAILURE_THRESHOLD) {
      user.lockedUntil = new Date(Date.now() + LOGIN_LOCKOUT_MS);
      user.failedLogins = 0;
    }
    return 'invalid';
  }
  if (user.failedLogins || user.lockedUntil) {
    user.failedLogins = 0;
    user.lockedUntil = null;
  }
  return 'ok';
};

// Re-authentication gate shared by confirm-delete and verify-change. Both
// flows require the caller to prove current credential ownership on top of
// having a valid JWT, so a stolen token alone cannot complete the action.
//
// For password accounts: verifies the supplied password and mutates the doc's
//   lockout fields. Callers must save() the doc before proceeding.
// For Google-only accounts: verifies the idToken and checks sub matches.
//
// Throws the appropriate AppError on failure so the route stays thin.
export const requireReauth = async (
  user: InstanceType<typeof User>,
  body: { password?: string; idToken?: string },
): Promise<void> => {
  if (user.passwordHash) {
    if (!body.password) {
      throw new BadRequestError('password_required');
    }
    const authResult = await checkPasswordAuth(user, body.password);
    await userRepository.save(user);
    if (authResult === 'locked') throw new LockedError('account_locked');
    if (authResult === 'invalid') throw new UnauthorizedError('invalid_credentials');
  } else {
    // Google-only account: require a fresh ID token whose sub matches the
    // linked googleId. The ID token is signed by Google and short-lived, so
    // possession proves current control of the Google login.
    if (!googleClient || googleAudiences.length === 0) {
      throw new ServiceUnavailableError('google_auth_disabled');
    }
    if (!body.idToken) {
      throw new BadRequestError('id_token_required');
    }
    let payload: { sub?: string } | undefined;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: body.idToken,
        audience: googleAudiences,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedError('invalid_google_token');
    }
    if (!payload?.sub || payload.sub !== user.googleId) {
      throw new UnauthorizedError('invalid_google_token');
    }
  }
};

// Issues a fresh verification code for a given purpose (account_delete or
// email_change). Enforces the per-account cooldown and de-duplicates any
// prior unconsumed codes. Returns { expiresInSeconds }.
//
// For email_change the code is sent to newEmail (the target address) and the
// newEmail field is stored on the record. For account_delete it goes to
// user.email and newEmail is not stored.
//
// Throws TooManyRequestsError('code_recently_sent') if on cooldown.
// Throws ServiceUnavailableError('mail_send_failed') if SMTP fails.
export const issueAuthCode = async (
  user: InstanceType<typeof User>,
  purpose: 'account_delete' | 'email_change',
  opts?: { newEmail?: string },
): Promise<{ sent: true; expiresInSeconds: number }> => {
  const onCooldown = await verificationCodeRepository.findRecent(
    user._id,
    purpose,
    CODE_RESEND_COOLDOWN_MS,
  );
  if (onCooldown) {
    throw new TooManyRequestsError('code_recently_sent');
  }

  await verificationCodeRepository.deleteUnconsumed(user._id, purpose);

  const code = generateCode();
  await verificationCodeRepository.create({
    email: user.email,
    code,
    purpose,
    userId: user._id,
    newEmail: opts?.newEmail,
    expiresAt: new Date(Date.now() + CODE_TTL_MS),
  });

  const sendTo = opts?.newEmail ?? user.email;
  const reason = purpose === 'account_delete' ? 'account deletion' : 'email change';
  try {
    await sendVerificationCode(sendTo, code, reason);
  } catch {
    throw new ServiceUnavailableError('mail_send_failed');
  }

  return { sent: true as const, expiresInSeconds: CODE_TTL_SECONDS };
};

// Verifies the supplied code against the latest valid record for this user +
// purpose. Enforces MAX_ATTEMPTS and the per-account reset lockout (for
// password_reset only). Returns the matching record on success.
//
// Throws:
//   BadRequestError('code_expired')         - no valid record
//   TooManyRequestsError('too_many_attempts') - record attempts exhausted
//   BadRequestError('invalid_code')          - wrong code
export const verifyAuthCode = async (
  user: InstanceType<typeof User>,
  purpose: 'account_delete' | 'email_change' | 'password_reset',
  submittedCode: string,
): Promise<InstanceType<typeof VerificationCode>> => {
  const record = await verificationCodeRepository.findLatestValid(user._id, purpose);

  if (!record) {
    throw new BadRequestError('code_expired');
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    throw new TooManyRequestsError('too_many_attempts');
  }
  if (!safeCodeEqual(record.code, submittedCode)) {
    await verificationCodeRepository.incrementAttempts(record._id);

    if (purpose === 'password_reset') {
      user.resetFailedAttempts = (user.resetFailedAttempts ?? 0) + 1;
      if (user.resetFailedAttempts >= RESET_LOCKOUT_THRESHOLD) {
        user.resetLockedUntil = new Date(Date.now() + RESET_LOCKOUT_MS);
        user.resetFailedAttempts = 0;
      }
      await userRepository.save(user);
    }

    throw new BadRequestError('invalid_code');
  }

  return record;
};

// -- Service methods (called by route handlers) --------------------------------

export const authService = {
  // Returns the created user document. Throws ConflictError('email_taken') on
  // duplicate email. Fires seed tasks as fire-and-forget; the log callback is
  // provided by the route so app.log stays out of the service.
  async register(
    body: { email: string; password: string; name: string },
    onSeedError: (err: unknown, label: string) => void,
  ) {
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
  },

  // Returns the authenticated user document. Route signs the JWT.
  async login(body: { email: string; password: string }) {
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
  },

  // Verifies a Google ID token. Returns { user, isNew } where isNew signals
  // the route to fire seed tasks. Throws appropriate AppErrors on failure.
  async googleSignIn(
    idToken: string,
    onSeedError: (err: unknown, label: string) => void,
  ): Promise<{ user: InstanceType<typeof User>; isNew: boolean }> {
    if (!googleClient || googleAudiences.length === 0) {
      throw new ServiceUnavailableError('google_auth_disabled');
    }
    let payload:
      | {
          email?: string;
          sub?: string;
          name?: string;
          given_name?: string;
          picture?: string;
          email_verified?: boolean;
        }
      | undefined;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: googleAudiences,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedError('invalid_google_token');
    }
    if (!payload?.email || !payload.sub) {
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
  },

  // Attaches a Google sub to the authenticated account. The token's email
  // must match the account email (closes the cross-account link takeover).
  async linkGoogle(
    userId: string,
    idToken: string,
  ): Promise<InstanceType<typeof User>> {
    if (!googleClient || googleAudiences.length === 0) {
      throw new ServiceUnavailableError('google_auth_disabled');
    }
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError();

    let payload:
      | {
          email?: string;
          sub?: string;
          picture?: string;
          email_verified?: boolean;
        }
      | undefined;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: googleAudiences,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedError('invalid_google_token');
    }
    if (!payload?.email || !payload.sub) {
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
    await userRepository.save(user);
    return user;
  },

  async getMe(userId: string): Promise<InstanceType<typeof User>> {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError();
    return user;
  },

  async updateMe(
    userId: string,
    body: Partial<{ name: string; avatar: string; prefs: Record<string, unknown> }>,
  ): Promise<InstanceType<typeof User>> {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError();
    if (body.name) user.name = body.name;
    if (body.avatar !== undefined) {
      const a = body.avatar;
      // Allow: empty, 1-2 char initials, safe data: image MIME types, https URLs.
      // Reject SVG (XSS via <script>) and any non-https URL.
      const ok =
        a === '' ||
        /^[A-Z0-9]{1,2}$/.test(a) ||
        /^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a) ||
        /^https:\/\/[^\s<>"]+$/.test(a);
      if (!ok) throw new BadRequestError('invalid_avatar');
      user.avatar = a;
    }
    if (body.prefs && user.prefs) Object.assign(user.prefs, body.prefs);
    await userRepository.save(user);
    return user;
  },

  // Generates and emails a code for account deletion. Returns { sent, expiresInSeconds }.
  async requestDelete(userId: string): Promise<{ sent: true; expiresInSeconds: number }> {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError();
    return issueAuthCode(user, 'account_delete');
  },

  // Re-authenticates, verifies the code, then deletes all user data atomically.
  async confirmDelete(
    userId: string,
    body: { code: string; password?: string; idToken?: string },
  ): Promise<void> {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError();

    await requireReauth(user, body);

    await verifyAuthCode(user, 'account_delete', body.code);

    // Wrap the cascade in a transaction (on replica sets) so a mid-cascade
    // failure rolls back instead of leaving orphan documents attached to a
    // deleted user. On standalone Mongo the helper falls back to non-atomic
    // writes (documented dev-only caveat).
    const uid = user._id;
    await withMaybeTransaction(async (session) => {
      await Promise.all([
        transactionRepository.deleteByUser(String(uid), session),
        budgetRepository.deleteByUser(String(uid), session),
        categoryRepository.deleteByUser(String(uid), session),
        debtRepository.deleteByUser(String(uid), session),
        notificationRepository.deleteByUser(String(uid), session),
        recurringRepository.deleteByUser(String(uid), session),
        walletRepository.deleteByUser(String(uid), session),
        verificationCodeRepository.deleteByUser(uid, session),
      ]);
      await userRepository.deleteById(uid, session);
    });
  },

  // Generates and emails a code for email change. Returns { sent, expiresInSeconds }.
  // Silent no-op (returns same shape without sending) when newEmail is already
  // registered, to prevent enumerating other users' addresses.
  async requestEmailChange(
    userId: string,
    newEmailRaw: string,
  ): Promise<{ sent: true; expiresInSeconds: number }> {
    const newEmail = normalizeEmail(newEmailRaw);
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError();
    if (user.email === newEmail) throw new BadRequestError('same_email');

    // Cooldown checked before the taken-email branch so timing/shape is the
    // same whether or not the target address is registered.
    const onCooldown = await verificationCodeRepository.findRecent(
      user._id,
      'email_change',
      CODE_RESEND_COOLDOWN_MS,
    );
    if (onCooldown) throw new TooManyRequestsError('code_recently_sent');

    // Treat already-registered targets as a silent no-op. Returning { sent: true }
    // either way denies an authenticated caller an oracle for enumerating other
    // users' email addresses. The legit user discovers the conflict when
    // verify-change rejects the code they never receive.
    const taken = await userRepository.findByEmail(newEmail);
    if (!taken) {
      await verificationCodeRepository.deleteUnconsumed(user._id, 'email_change');
      const code = generateCode();
      await verificationCodeRepository.create({
        email: user.email,
        newEmail,
        code,
        purpose: 'email_change',
        userId: user._id,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });
      try {
        await sendVerificationCode(newEmail, code, 'email change');
      } catch {
        throw new ServiceUnavailableError('mail_send_failed');
      }
    }

    return { sent: true, expiresInSeconds: CODE_TTL_SECONDS };
  },

  // Re-authenticates, verifies the code, and applies the email change.
  // Bumps passwordChangedAt to revoke all prior JWTs (email change is
  // credential-equivalent). Returns the updated user document.
  async verifyEmailChange(
    userId: string,
    body: { code: string; password?: string; idToken?: string },
  ): Promise<InstanceType<typeof User>> {
    const user = await userRepository.findById(userId);
    if (!user) throw new NotFoundError();

    await requireReauth(user, body);

    const record = await verifyAuthCode(user, 'email_change', body.code);

    if (!record.newEmail) throw new BadRequestError('invalid_state');

    const stillTaken = await userRepository.findByEmail(record.newEmail);
    if (stillTaken && stillTaken.id !== user.id) {
      throw new ConflictError('email_taken');
    }

    user.email = record.newEmail;
    // Email change is a credential-equivalent event: revoke prior JWTs.
    user.passwordChangedAt = new Date();
    try {
      await userRepository.save(user);
    } catch (err) {
      if (isDuplicateKeyError(err)) throw new ConflictError('email_taken');
      throw err;
    }
    await verificationCodeRepository.consume(record._id);

    return user;
  },

  // Generates and emails a password reset code. Always returns
  // { sent, expiresInSeconds } regardless of whether the email is registered
  // (never leaks account existence). SMTP is fire-and-forget.
  async forgotPassword(emailRaw: string): Promise<{ sent: true; expiresInSeconds: number }> {
    const email = normalizeEmail(emailRaw);
    const user = await userRepository.findByEmail(email);

    if (user) {
      // Cooldown: if a code was issued for this account in the last minute, do
      // NOT send another (anti mail-bombing). Response stays identical.
      const onCooldown = await verificationCodeRepository.findRecent(
        user._id,
        'password_reset',
        CODE_RESEND_COOLDOWN_MS,
      );
      if (!onCooldown) {
        await verificationCodeRepository.deleteUnconsumed(user._id, 'password_reset');
        const code = generateCode();
        await verificationCodeRepository.create({
          email,
          code,
          purpose: 'password_reset',
          userId: user._id,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        });
        // Fire-and-forget: SMTP latency (~200-500 ms) would dwarf every other
        // timing component and reveal account existence if awaited. Errors are
        // swallowed for the same reason.
        void sendVerificationCode(email, code, 'password reset').catch(() => {});
      }
    } else {
      // Match the wall-clock shape of the user-exists branch so attackers
      // cannot distinguish "no account" from "account but SMTP queued in
      // background" by measuring response time. These two reads cost roughly
      // the same as deleteMany + create without writing dummy rows.
      await verificationCodeRepository.timingProbe(email);
    }

    return { sent: true, expiresInSeconds: CODE_TTL_SECONDS };
  },

  // Verifies a password reset code. Returns the email (normalised) and the
  // live user document. The route uses the email to mint the verifiedToken.
  // Does NOT consume the code (that happens in resetPassword).
  async verifyResetCode(
    emailRaw: string,
    submittedCode: string,
  ): Promise<{ user: InstanceType<typeof User>; email: string }> {
    const email = normalizeEmail(emailRaw);
    const user = await userRepository.findByEmail(email);
    if (!user) throw new BadRequestError('invalid_code');

    // Per-account lockout survives /password/forgot re-issuance.
    if (user.resetLockedUntil && user.resetLockedUntil.getTime() > Date.now()) {
      throw new TooManyRequestsError('too_many_attempts');
    }

    await verifyAuthCode(user, 'password_reset', submittedCode);

    return { user, email };
  },

  // Applies the new password after verifying the code and verifiedToken (which
  // the route validates before calling this). Consumes the code, revokes prior
  // JWTs via passwordChangedAt, and clears the reset lockout. Returns the user.
  async resetPassword(
    emailRaw: string,
    submittedCode: string,
    newPassword: string,
  ): Promise<InstanceType<typeof User>> {
    const email = normalizeEmail(emailRaw);
    const user = await userRepository.findByEmail(email);
    if (!user) throw new BadRequestError('invalid_code');

    // Per-account lockout survives /password/forgot re-issuance.
    if (user.resetLockedUntil && user.resetLockedUntil.getTime() > Date.now()) {
      throw new TooManyRequestsError('too_many_attempts');
    }

    const record = await verifyAuthCode(user, 'password_reset', submittedCode);

    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // Bumping passwordChangedAt revokes every JWT issued before this moment.
    user.passwordChangedAt = new Date();
    // Successful reset clears the per-account brute-force lockout.
    user.resetFailedAttempts = 0;
    user.resetLockedUntil = null;
    await Promise.all([userRepository.save(user), verificationCodeRepository.consume(record._id)]);

    return user;
  },
};
