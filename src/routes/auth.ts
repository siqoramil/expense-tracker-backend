import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { withMaybeTransaction } from '../lib/db-tx.js';
import { env } from '../lib/env.js';
import { generateCode, sendVerificationCode } from '../lib/mailer.js';
import { normalizeEmail } from '../lib/normalize.js';
import {
  authResponse,
  codeSentResponse,
  errorResponseWith,
  userResponse,
} from '../lib/schemas.js';
import { DUMMY_PASSWORD_HASH, safeCodeEqual } from '../lib/security.js';
import { seedDefaultCategories } from '../lib/defaultCategories.js';
import { seedDefaultWallets } from '../lib/defaultWallets.js';
import { Budget } from '../models/Budget.js';
import { Category } from '../models/Category.js';
import { Debt } from '../models/Debt.js';
import { Notification } from '../models/Notification.js';
import { Recurring } from '../models/Recurring.js';
import { Transaction } from '../models/Transaction.js';
import { User } from '../models/User.js';
import { VerificationCode } from '../models/VerificationCode.js';
import { Wallet } from '../models/Wallet.js';

const googleAudiences = [
  env.google.webClientId,
  env.google.iosClientId,
  env.google.androidClientId,
].filter((id) => id.length > 0);

const googleClient = googleAudiences.length > 0 ? new OAuth2Client() : null;

const initialsFrom = (name: string) =>
  name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

// Mongo emits code 11000 on a unique-index violation. Mongoose can also wrap
// the driver error as a ValidationError with a nested cause, so check both.
const isDuplicateKeyError = (err: unknown): boolean => {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: number; cause?: { code?: number } };
  return e.code === 11000 || e.cause?.code === 11000;
};

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// Minimum gap between successive verification-code emails for the same account
// + purpose. Stops mail-bombing: spamming /password/forgot or
// /email/request-change can't fire more than one email per minute per account.
const CODE_RESEND_COOLDOWN_MS = 60 * 1000;

// Returns true when an unconsumed, unexpired code for this user + purpose was
// issued within the cooldown window (i.e. a fresh email was just sent).
const codeOnCooldown = async (
  userId: unknown,
  purpose: 'password_reset' | 'email_change' | 'account_delete',
): Promise<boolean> => {
  const recent = await VerificationCode.findOne({
    userId,
    purpose,
    consumed: false,
    expiresAt: { $gt: new Date() },
    createdAt: { $gt: new Date(Date.now() - CODE_RESEND_COOLDOWN_MS) },
  })
    .select({ _id: 1 })
    .lean();
  return Boolean(recent);
};

// At least 8 chars, must contain a letter and a digit.
const PASSWORD_PATTERN = '^(?=.*[A-Za-z])(?=.*\\d).{8,128}$';

// 2026 baseline. 10 rounds is ~10x faster on modern GPUs than it was in
// 2015; 12 keeps brute-force costs in the tens-of-ms range per guess.
const BCRYPT_ROUNDS = 12;

// Account-level brute-force lockout. The 200 req/min IP cap catches
// floods; this catches slow distributed attacks (one guess per IP per
// minute across thousands of IPs would otherwise be unbounded).
const LOGIN_FAILURE_THRESHOLD = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

// Per-account brute-force lockout for password reset codes. The per-record
// MAX_ATTEMPTS counter resets every time /password/forgot issues a fresh
// code, so an attacker could otherwise refresh their guess budget at will.
// These User-level fields survive re-issuance and cap total wrong guesses.
const RESET_LOCKOUT_THRESHOLD = 5;
const RESET_LOCKOUT_MS = 15 * 60 * 1000;

// Short-lived JWT used by /password/verify-code to prove the code was
// checked before /password/reset accepts it. exp=2min is tight enough
// that a leaked token is useless by the time an attacker replays it.
const VERIFIED_TOKEN_TTL = '2m';

// Checks lockout, compares password, and updates failure/lockout counters.
// Returns 'locked' | 'invalid' | 'ok'. Callers must save() the user on 'ok'
// or 'invalid' (the model is mutated in-place so a single save suffices).
const checkPasswordAuth = async (
  user: InstanceType<typeof User>,
  password: string,
): Promise<'locked' | 'invalid' | 'ok'> => {
  if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
    // Equalize timing: run the same bcrypt work the non-locked path does so
    // a locked account isn't measurably faster to probe (timing oracle).
    // The result is intentionally discarded.
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

// Strict rate limits for credential-touching routes.
const tightLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };
const codeLimit = { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } };

const authRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: { email: string; password: string; name: string } }>(
    '/register',
    {
      ...tightLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Register a new account',
        description:
          'Creates a user with email/password credentials. Returns a signed JWT and the user profile. Rate limited to 10 req/min per IP.',
        body: {
          type: 'object',
          required: ['email', 'password', 'name'],
          properties: {
            email: {
              type: 'string',
              format: 'email',
              maxLength: 200,
              description: 'The email address for the new account.',
              example: 'jane@example.com',
            },
            password: {
              type: 'string',
              pattern: PASSWORD_PATTERN,
              maxLength: 128,
              description: 'At least 8 characters; must contain at least one letter and one digit.',
              example: 'Secret1234',
            },
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 80,
              description: 'Display name shown in the app.',
              example: 'Jane Doe',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: authResponse,
          400: errorResponseWith(['bad_request']),
          409: errorResponseWith(['email_taken']),
          429: errorResponseWith(['rate_limit_exceeded']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const { password, name } = req.body;
      const email = normalizeEmail(req.body.email);
      const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const avatar = initialsFrom(name);
      try {
        const user = await User.create({ email, passwordHash, name, avatar });
        const pca = Math.floor((user.passwordChangedAt?.getTime() ?? 0) / 1000);
        const token = app.jwt.sign({ sub: user.id as string, pca });
        seedDefaultCategories(user._id).catch((err) =>
          app.log.error({ err }, 'seedDefaultCategories failed on register'),
        );
        seedDefaultWallets(user._id).catch((err) =>
          app.log.error({ err }, 'seedDefaultWallets failed on register'),
        );
        return { token, user: toUserDTO(user) };
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          return reply.code(409).send({ error: 'email_taken' });
        }
        throw err;
      }
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/login',
    {
      ...tightLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Sign in with email + password',
        description:
          'Authenticates an existing user. Returns a signed JWT and the user profile on success. Rate limited to 10 req/min per IP. After 5 consecutive failed attempts the account is locked for 15 minutes (423).',
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: {
              type: 'string',
              maxLength: 200,
              description: 'Registered email address.',
              example: 'jane@example.com',
            },
            password: {
              type: 'string',
              maxLength: 128,
              description: 'Account password.',
              example: 'Secret1234',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: authResponse,
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['invalid_credentials']),
          423: errorResponseWith(['account_locked']),
          429: errorResponseWith(['rate_limit_exceeded']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const { password } = req.body;
      const email = normalizeEmail(req.body.email);
      const user = await User.findOne({ email });

      // Tally failures on real password accounts only. Google-only accounts
      // have an empty passwordHash and can't be brute-forced through this
      // endpoint, so locking them would just deny service for no benefit.
      const isPasswordAccount = Boolean(user?.passwordHash);

      if (!user || !isPasswordAccount) {
        // Always run bcrypt against a dummy hash so "unknown email" and
        // "wrong password" take the same wall-clock time — a 20× timing
        // gap would otherwise enumerate registered emails.
        await bcrypt.compare(password, DUMMY_PASSWORD_HASH);
        return reply.code(401).send({ error: 'invalid_credentials' });
      }

      const result = await checkPasswordAuth(user, password);
      await user.save();

      if (result === 'locked') return reply.code(423).send({ error: 'account_locked' });
      if (result === 'invalid') return reply.code(401).send({ error: 'invalid_credentials' });

      const pca = Math.floor((user.passwordChangedAt?.getTime() ?? 0) / 1000);
      const token = app.jwt.sign({ sub: user.id as string, pca });
      return { token, user: toUserDTO(user) };
    },
  );

  app.post<{ Body: { idToken: string } }>(
    '/google',
    {
      ...tightLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Sign in with Google',
        description:
          "Verifies a Google ID token, then creates or links a local user account and returns a signed JWT. Returns 503 when Google sign-in is not configured on the server. Returns 409 when the Google email matches an existing password-only account that has not yet explicitly linked Google (use POST /auth/google/link instead).",
        body: {
          type: 'object',
          required: ['idToken'],
          properties: {
            idToken: {
              type: 'string',
              minLength: 20,
              maxLength: 4096,
              description: 'Google-issued ID token obtained from the client SDK (sign_in_with_credential).',
              example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ii4uLiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: authResponse,
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['invalid_google_token', 'email_not_verified']),
          409: errorResponseWith(['account_link_required']),
          429: errorResponseWith(['rate_limit_exceeded']),
          500: errorResponseWith(['internal_error']),
          503: errorResponseWith(['google_auth_disabled']),
        },
      },
    },
    async (req, reply) => {
      if (!googleClient || googleAudiences.length === 0) {
        return reply.code(503).send({ error: 'google_auth_disabled' });
      }
      let payload;
      try {
        const ticket = await googleClient.verifyIdToken({
          idToken: req.body.idToken,
          audience: googleAudiences,
        });
        payload = ticket.getPayload();
      } catch {
        return reply.code(401).send({ error: 'invalid_google_token' });
      }
      if (!payload?.email || !payload.sub) {
        return reply.code(401).send({ error: 'invalid_google_token' });
      }
      if (payload.email_verified === false) {
        return reply.code(401).send({ error: 'email_not_verified' });
      }

      const email = normalizeEmail(payload.email);
      const name = payload.name || payload.given_name || email.split('@')[0];
      const picture = payload.picture ?? '';

      // Look up by googleId only — never auto-link a Google sub onto an
      // existing password-only account by email match. That used to enable
      // an account-takeover: if user A registered "victim@x.com" with a
      // password (without owning the inbox), the real Google owner could
      // sign in and silently take over. Linking now requires an explicit
      // step at /auth/google/link while logged into the password account.
      let user = await User.findOne({ googleId: payload.sub });
      if (!user) {
        const collision = await User.findOne({ email });
        if (collision) {
          return reply.code(409).send({ error: 'account_link_required' });
        }
        try {
          user = await User.create({
            email,
            name,
            googleId: payload.sub,
            avatar: picture || initialsFrom(name),
            passwordHash: '',
          });
        } catch (err) {
          if (isDuplicateKeyError(err)) {
            // Race: another request created a same-email account between
            // our check and create. Fail closed and tell the client to
            // perform an explicit link from the existing account.
            return reply.code(409).send({ error: 'account_link_required' });
          }
          throw err;
        }
        seedDefaultCategories(user._id).catch((err) =>
          app.log.error({ err }, 'seedDefaultCategories failed on google register'),
        );
        seedDefaultWallets(user._id).catch((err) =>
          app.log.error({ err }, 'seedDefaultWallets failed on google register'),
        );
      } else if (!user.avatar && picture) {
        user.avatar = picture;
        await user.save();
      }

      const pca = Math.floor((user.passwordChangedAt?.getTime() ?? 0) / 1000);
      const token = app.jwt.sign({ sub: user.id as string, pca });
      return { token, user: toUserDTO(user) };
    },
  );

  // Explicit, authenticated linking of a Google identity onto the current
  // account. The caller must already be signed in with their password and
  // the Google ID token's email must match the account's email — both
  // checks together close the auto-link takeover gap.
  app.post<{ Body: { idToken: string } }>(
    '/google/link',
    {
      ...tightLimit,
      preHandler: app.auth,
      schema: {
        tags: ['Auth'],
        summary: 'Link Google to current account',
        description:
          "Attaches a Google sub to the authenticated user. The Google ID token's email must match the account's email. Returns 409 if the Google sub is already linked to a different account, or if the token email does not match the account email.",
        body: {
          type: 'object',
          required: ['idToken'],
          properties: {
            idToken: {
              type: 'string',
              minLength: 20,
              maxLength: 4096,
              description: 'Fresh Google ID token whose email must match the current account.',
              example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ii4uLiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: userResponse,
          400: errorResponseWith(['bad_request']),
          401: errorResponseWith(['invalid_google_token', 'email_not_verified']),
          404: errorResponseWith(['not_found']),
          409: errorResponseWith(['email_mismatch', 'google_account_in_use']),
          429: errorResponseWith(['rate_limit_exceeded']),
          500: errorResponseWith(['internal_error']),
          503: errorResponseWith(['google_auth_disabled']),
        },
      },
    },
    async (req, reply) => {
      if (!googleClient || googleAudiences.length === 0) {
        return reply.code(503).send({ error: 'google_auth_disabled' });
      }
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });

      let payload;
      try {
        const ticket = await googleClient.verifyIdToken({
          idToken: req.body.idToken,
          audience: googleAudiences,
        });
        payload = ticket.getPayload();
      } catch {
        return reply.code(401).send({ error: 'invalid_google_token' });
      }
      if (!payload?.email || !payload.sub) {
        return reply.code(401).send({ error: 'invalid_google_token' });
      }
      if (payload.email_verified === false) {
        return reply.code(401).send({ error: 'email_not_verified' });
      }
      if (normalizeEmail(payload.email) !== user.email) {
        return reply.code(409).send({ error: 'email_mismatch' });
      }
      const already = await User.findOne({ googleId: payload.sub });
      if (already && already.id !== user.id) {
        return reply.code(409).send({ error: 'google_account_in_use' });
      }
      user.googleId = payload.sub;
      if (!user.avatar && payload.picture) user.avatar = payload.picture;
      await user.save();
      return { user: toUserDTO(user) };
    },
  );

  app.get(
    '/me',
    {
      preHandler: app.auth,
      schema: {
        tags: ['Auth'],
        summary: 'Get current user',
        description: 'Returns the profile of the authenticated user. The 404 case occurs when the JWT is valid but the user document was deleted between token issuance and this call.',
        response: {
          200: userResponse,
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      return { user: toUserDTO(user) };
    },
  );

  app.patch<{ Body: Partial<{ name: string; avatar: string; prefs: Record<string, unknown> }> }>(
    '/me',
    {
      preHandler: app.auth,
      // Avatars can be a ~600 KB base64 data URI. The global bodyLimit is
      // tightened to 1 MB, so this route opts into a slightly larger cap.
      bodyLimit: 750_000,
      schema: {
        tags: ['Auth'],
        summary: 'Update current user',
        description:
          "Patches the user's name, avatar, and/or preferences. Avatars must be empty string, 1-2 uppercase char initials, an https:// URL, or a base64 data URI for jpeg/png/webp/gif (SVG is rejected to prevent XSS). Body size limit is 750 KB.",
        body: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              minLength: 1,
              maxLength: 80,
              description: 'Display name.',
              example: 'Jane Doe',
            },
            avatar: {
              type: 'string',
              // ~600KB ceiling: enough for the mobile picker's 0.3-quality
              // 1:1 crops (~150-300KB base64) without bloating User docs.
              // TODO: move to S3/CDN and store only a URL -- Mongo's 16MB
              // doc cap and oplog amplification make inline images a
              // foot-gun at scale.
              maxLength: 600_000,
              description:
                'Empty string to clear, 1-2 char initials, an https:// URL, or a base64 data URI (jpeg/png/webp/gif, max ~600 KB). SVG is rejected.',
              example: 'JD',
            },
            prefs: {
              type: 'object',
              properties: {
                lang: {
                  type: 'string',
                  enum: ['en', 'uz', 'ru', 'de', 'fr', 'es'],
                  description: 'Preferred UI language.',
                  example: 'en',
                },
                currency: {
                  type: 'string',
                  enum: ['UZS', 'USD', 'EUR', 'GBP', 'RUB'],
                  description: 'Preferred display currency.',
                  example: 'USD',
                },
                dark: { type: 'boolean', description: 'Dark mode enabled.', example: false },
                pin: { type: 'boolean', description: 'PIN lock enabled.', example: false },
                notifications: { type: 'boolean', description: 'Push notifications enabled.', example: true },
                biometric: { type: 'boolean', description: 'Biometric unlock enabled.', example: false },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        response: {
          200: userResponse,
          400: errorResponseWith(['bad_request', 'invalid_avatar']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      if (req.body.name) user.name = req.body.name;
      if (req.body.avatar !== undefined) {
        const a = req.body.avatar;
        // Allow: empty, 1-2 char initials, safe data: image MIME types, https URLs.
        // Reject SVG (XSS via <script>) and any non-https URL.
        const ok =
          a === '' ||
          /^[A-Z0-9]{1,2}$/.test(a) ||
          /^data:image\/(jpeg|jpg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(a) ||
          /^https:\/\/[^\s<>"]+$/.test(a);
        if (!ok) return reply.code(400).send({ error: 'invalid_avatar' });
        user.avatar = a;
      }
      if (req.body.prefs && user.prefs) Object.assign(user.prefs, req.body.prefs);
      await user.save();
      return { user: toUserDTO(user) };
    },
  );

  app.post(
    '/account/request-delete',
    {
      ...codeLimit,
      preHandler: app.auth,
      schema: {
        tags: ['Auth'],
        summary: 'Request account deletion code',
        description:
          'Generates a 6-digit code, emails it to the account owner, and stores it for confirmation. Codes expire after 10 minutes. Rate limited to 5 req/min per IP. Follow up with POST /auth/account/confirm-delete.',
        response: {
          200: codeSentResponse,
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          429: errorResponseWith(['code_recently_sent', 'rate_limit_exceeded']),
          500: errorResponseWith(['internal_error']),
          503: errorResponseWith(['mail_send_failed']),
        },
      },
    },
    async (req, reply) => {
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });

      // Cooldown: refuse to re-send if a code was issued in the last minute.
      if (await codeOnCooldown(user._id, 'account_delete')) {
        return reply.code(429).send({ error: 'code_recently_sent' });
      }

      await VerificationCode.deleteMany({
        userId: user._id,
        purpose: 'account_delete',
        consumed: false,
      });

      const code = generateCode();
      await VerificationCode.create({
        email: user.email,
        code,
        purpose: 'account_delete',
        userId: user._id,
        expiresAt: new Date(Date.now() + CODE_TTL_MS),
      });

      // Surface mail failures as an app-level 503 the client can map to a
      // user-readable message, instead of a generic 500. The orphaned code
      // record is harmless — it expires in 10 minutes.
      try {
        await sendVerificationCode(user.email, code, 'account deletion');
      } catch {
        return reply.code(503).send({ error: 'mail_send_failed' });
      }
      return { sent: true, expiresInSeconds: CODE_TTL_MS / 1000 };
    },
  );

  app.post<{ Body: { code: string; password?: string; idToken?: string } }>(
    '/account/confirm-delete',
    {
      ...tightLimit,
      preHandler: app.auth,
      schema: {
        tags: ['Auth'],
        summary: 'Confirm account deletion',
        description:
          'Verifies the 6-digit code from POST /auth/account/request-delete AND re-authenticates the caller (password for password accounts, fresh Google ID token for Google-only accounts), then permanently deletes the user along with all of their data (transactions, wallets, budgets, categories, debts, recurring entries, notifications). Returns 204 on success. Locked after 5 failed code attempts.',
        body: {
          type: 'object',
          required: ['code'],
          properties: {
            code: {
              type: 'string',
              pattern: '^[0-9]{6}$',
              description: '6-digit numeric code emailed by POST /auth/account/request-delete.',
              example: '482910',
            },
            password: {
              type: 'string',
              maxLength: 128,
              description: 'Current password. Required when the account has a password set (hasPassword=true).',
              example: 'Secret1234',
            },
            idToken: {
              type: 'string',
              minLength: 20,
              maxLength: 4096,
              description:
                'Fresh Google ID token. Required when the account is Google-only (hasPassword=false, hasGoogle=true).',
              example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ii4uLiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
            },
          },
          additionalProperties: false,
        },
        response: {
          204: { type: 'object', description: 'Account and all associated data permanently deleted.' },
          400: errorResponseWith(['bad_request', 'password_required', 'id_token_required', 'code_expired', 'invalid_code']),
          401: errorResponseWith(['unauthorized', 'invalid_credentials', 'invalid_google_token']),
          404: errorResponseWith(['not_found']),
          423: errorResponseWith(['account_locked']),
          429: errorResponseWith(['too_many_attempts', 'rate_limit_exceeded']),
          500: errorResponseWith(['internal_error']),
          503: errorResponseWith(['google_auth_disabled']),
        },
      },
    },
    async (req, reply) => {
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });

      // Re-auth: a stolen JWT plus a one-shot peek at the inbox must NOT be
      // enough to wipe the account. Demand a credential the attacker is
      // unlikely to also possess.
      if (user.passwordHash) {
        if (!req.body.password) {
          return reply.code(400).send({ error: 'password_required' });
        }
        const authResult = await checkPasswordAuth(user, req.body.password);
        await user.save();
        if (authResult === 'locked') return reply.code(423).send({ error: 'account_locked' });
        if (authResult === 'invalid') return reply.code(401).send({ error: 'invalid_credentials' });
      } else {
        // Google-only account: require a fresh ID token whose sub matches
        // the linked googleId. The ID token is signed by Google and short-
        // lived, so possession proves current control of the Google login.
        if (!googleClient || googleAudiences.length === 0) {
          return reply.code(503).send({ error: 'google_auth_disabled' });
        }
        if (!req.body.idToken) {
          return reply.code(400).send({ error: 'id_token_required' });
        }
        let payload;
        try {
          const ticket = await googleClient.verifyIdToken({
            idToken: req.body.idToken,
            audience: googleAudiences,
          });
          payload = ticket.getPayload();
        } catch {
          return reply.code(401).send({ error: 'invalid_google_token' });
        }
        if (!payload?.sub || payload.sub !== user.googleId) {
          return reply.code(401).send({ error: 'invalid_google_token' });
        }
      }

      const record = await VerificationCode.findOne({
        userId: user._id,
        purpose: 'account_delete',
        consumed: false,
        expiresAt: { $gt: new Date() },
      }).sort({ createdAt: -1 });

      if (!record) return reply.code(400).send({ error: 'code_expired' });
      if (record.attempts >= MAX_ATTEMPTS) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      if (!safeCodeEqual(record.code, req.body.code)) {
        await VerificationCode.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
        return reply.code(400).send({ error: 'invalid_code' });
      }

      // Wrap the cascade in a transaction (on replica sets) so a
      // mid-cascade failure rolls back instead of leaving orphan rows
      // attached to a now-deleted user. On standalone Mongo the helper
      // falls back to non-atomic writes — flagged in the deployment
      // notes as a known dev-only caveat.
      const userId = user._id;
      await withMaybeTransaction(async (session) => {
        const sessionOpt = session ? { session } : {};
        await Promise.all([
          Transaction.deleteMany({ userId }, sessionOpt),
          Budget.deleteMany({ userId }, sessionOpt),
          Category.deleteMany({ userId }, sessionOpt),
          Debt.deleteMany({ userId }, sessionOpt),
          Notification.deleteMany({ userId }, sessionOpt),
          Recurring.deleteMany({ userId }, sessionOpt),
          Wallet.deleteMany({ userId }, sessionOpt),
          VerificationCode.deleteMany({ userId }, sessionOpt),
        ]);
        await user.deleteOne(sessionOpt);
      });

      return reply.code(204).send();
    },
  );

  app.post<{ Body: { newEmail: string } }>(
    '/email/request-change',
    {
      ...codeLimit,
      preHandler: app.auth,
      schema: {
        tags: ['Auth'],
        summary: 'Request email change code',
        description:
          'Sends a 6-digit code to the proposed new email address so the user can prove ownership. The response shape is identical whether or not the target address is already registered, to avoid leaking account existence to an authenticated caller. Codes expire after 10 minutes. Rate limited to 5 req/min per IP. Follow up with POST /auth/email/verify-change.',
        body: {
          type: 'object',
          required: ['newEmail'],
          properties: {
            newEmail: {
              type: 'string',
              format: 'email',
              maxLength: 200,
              description: 'The new email address the user wants to use.',
              example: 'jane.new@example.com',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: codeSentResponse,
          400: errorResponseWith(['bad_request', 'same_email']),
          401: errorResponseWith(['unauthorized']),
          404: errorResponseWith(['not_found']),
          429: errorResponseWith(['code_recently_sent', 'rate_limit_exceeded']),
          500: errorResponseWith(['internal_error']),
          503: errorResponseWith(['mail_send_failed']),
        },
      },
    },
    async (req, reply) => {
      const newEmail = normalizeEmail(req.body.newEmail);
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      if (user.email === newEmail) return reply.code(400).send({ error: 'same_email' });

      // Cooldown: refuse to re-send if a code was issued in the last minute.
      // Checked before the taken-email branch so the response timing/shape is
      // the same whether or not the target address is registered.
      if (await codeOnCooldown(user._id, 'email_change')) {
        return reply.code(429).send({ error: 'code_recently_sent' });
      }

      // Treat already-registered targets as a silent no-op: do NOT send a
      // code and do NOT create a VerificationCode record. Returning the
      // same { sent: true } shape either way denies an authenticated caller
      // an oracle for enumerating other users' email addresses. The legit
      // user discovers the conflict when verify-change rejects the code
      // they never receive.
      const taken = await User.findOne({ email: newEmail });
      if (!taken) {
        await VerificationCode.deleteMany({
          userId: user._id,
          purpose: 'email_change',
          consumed: false,
        });

        const code = generateCode();
        await VerificationCode.create({
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
          return reply.code(503).send({ error: 'mail_send_failed' });
        }
      }
      return { sent: true, expiresInSeconds: CODE_TTL_MS / 1000 };
    },
  );

  app.post<{ Body: { code: string; password?: string; idToken?: string } }>(
    '/email/verify-change',
    {
      ...tightLimit,
      preHandler: app.auth,
      schema: {
        tags: ['Auth'],
        summary: 'Verify email change',
        description:
          'Confirms the 6-digit code emailed to the new address AND re-authenticates the caller (password for password accounts, fresh Google ID token for Google-only accounts) before applying the change. A stolen JWT plus a one-time peek at the inbox must not be enough to take over the account. Bumping the email also revokes all prior JWTs (equivalent to a password change). Locked after 5 failed code attempts.',
        body: {
          type: 'object',
          required: ['code'],
          properties: {
            code: {
              type: 'string',
              pattern: '^[0-9]{6}$',
              description: '6-digit code received at the new email address.',
              example: '391847',
            },
            password: {
              type: 'string',
              maxLength: 128,
              description: 'Current password. Required when the account has a password set (hasPassword=true).',
              example: 'Secret1234',
            },
            idToken: {
              type: 'string',
              minLength: 20,
              maxLength: 4096,
              description: 'Fresh Google ID token. Required when the account is Google-only (hasPassword=false).',
              example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ii4uLiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: userResponse,
          400: errorResponseWith(['bad_request', 'password_required', 'id_token_required', 'code_expired', 'invalid_code', 'invalid_state']),
          401: errorResponseWith(['unauthorized', 'invalid_credentials', 'invalid_google_token']),
          404: errorResponseWith(['not_found']),
          409: errorResponseWith(['email_taken']),
          423: errorResponseWith(['account_locked']),
          429: errorResponseWith(['too_many_attempts', 'rate_limit_exceeded']),
          500: errorResponseWith(['internal_error']),
          503: errorResponseWith(['google_auth_disabled']),
        },
      },
    },
    async (req, reply) => {
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });

      // Re-auth: changing the login email is account-takeover-equivalent if
      // the JWT is stolen and the attacker can sniff the new-email inbox.
      // Demand a credential the attacker is unlikely to also possess.
      if (user.passwordHash) {
        if (!req.body.password) {
          return reply.code(400).send({ error: 'password_required' });
        }
        const authResult = await checkPasswordAuth(user, req.body.password);
        await user.save();
        if (authResult === 'locked') return reply.code(423).send({ error: 'account_locked' });
        if (authResult === 'invalid') return reply.code(401).send({ error: 'invalid_credentials' });
      } else {
        if (!googleClient || googleAudiences.length === 0) {
          return reply.code(503).send({ error: 'google_auth_disabled' });
        }
        if (!req.body.idToken) {
          return reply.code(400).send({ error: 'id_token_required' });
        }
        let payload;
        try {
          const ticket = await googleClient.verifyIdToken({
            idToken: req.body.idToken,
            audience: googleAudiences,
          });
          payload = ticket.getPayload();
        } catch {
          return reply.code(401).send({ error: 'invalid_google_token' });
        }
        if (!payload?.sub || payload.sub !== user.googleId) {
          return reply.code(401).send({ error: 'invalid_google_token' });
        }
      }

      const record = await VerificationCode.findOne({
        userId: user._id,
        purpose: 'email_change',
        consumed: false,
        expiresAt: { $gt: new Date() },
      }).sort({ createdAt: -1 });

      if (!record) return reply.code(400).send({ error: 'code_expired' });
      if (record.attempts >= MAX_ATTEMPTS) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }

      if (!safeCodeEqual(record.code, req.body.code)) {
        await VerificationCode.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
        return reply.code(400).send({ error: 'invalid_code' });
      }

      if (!record.newEmail) return reply.code(400).send({ error: 'invalid_state' });
      const stillTaken = await User.findOne({ email: record.newEmail });
      if (stillTaken && stillTaken.id !== user.id) {
        return reply.code(409).send({ error: 'email_taken' });
      }

      user.email = record.newEmail;
      // Email change is a credential-equivalent event — revoke prior JWTs so
      // any session that observed the old email cannot continue under the
      // new one without re-login.
      user.passwordChangedAt = new Date();
      try {
        await user.save();
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          return reply.code(409).send({ error: 'email_taken' });
        }
        throw err;
      }
      record.consumed = true;
      await record.save();

      return { user: toUserDTO(user) };
    },
  );

  app.post<{ Body: { email: string } }>(
    '/password/forgot',
    {
      ...codeLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Send password reset code',
        description:
          'Sends a 6-digit reset code to the email if an account with a password exists. The response shape is identical whether or not the email is registered, to avoid leaking account existence. SMTP send is fire-and-forget; failures are logged but do not surface as errors. Rate limited to 5 req/min per IP. Follow up with POST /auth/password/verify-code.',
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: {
              type: 'string',
              format: 'email',
              maxLength: 200,
              description: 'Email address of the account to reset.',
              example: 'jane@example.com',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: codeSentResponse,
          400: errorResponseWith(['bad_request']),
          429: errorResponseWith(['rate_limit_exceeded']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req) => {
      const email = normalizeEmail(req.body.email);
      const user = await User.findOne({ email });
      // Cooldown: if a reset code was issued for this account in the last
      // minute, do NOT send another (anti mail-bombing). The response stays
      // { sent: true } either way, so this never leaks account existence.
      if (user && (await codeOnCooldown(user._id, 'password_reset'))) {
        return { sent: true, expiresInSeconds: CODE_TTL_MS / 1000 };
      }
      if (user) {
        await VerificationCode.deleteMany({
          userId: user._id,
          purpose: 'password_reset',
          consumed: false,
        });
        const code = generateCode();
        await VerificationCode.create({
          email,
          code,
          purpose: 'password_reset',
          userId: user._id,
          expiresAt: new Date(Date.now() + CODE_TTL_MS),
        });
        // Don't await — SMTP latency (~200-500 ms) would dwarf every
        // other timing component and reveal account existence. Fire
        // and forget; failures are logged inside the mailer. Errors
        // are swallowed here for the same reason.
        void sendVerificationCode(email, code, 'password reset').catch(() => {});
      } else {
        // Match the wall-clock shape of the user-exists branch so
        // attackers can't distinguish "no account" from "account but
        // SMTP queued in background" by measuring response time. The
        // two queries below cost roughly the same as deleteMany +
        // create, without writing dummy rows that pollute the DB.
        await VerificationCode.findOne({
          userId: null,
          purpose: 'password_reset',
          email,
        }).lean();
        await VerificationCode.countDocuments({
          purpose: 'password_reset',
          email,
        });
      }
      return { sent: true, expiresInSeconds: CODE_TTL_MS / 1000 };
    },
  );

  app.post<{ Body: { email: string; code: string } }>(
    '/password/verify-code',
    {
      ...tightLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Verify password reset code',
        description:
          'Checks that the supplied reset code is valid for the given email and returns a short-lived verifiedToken (exp=2 min) that POST /auth/password/reset requires. Using a one-time token prevents the raw code from being replayed directly into the reset step. Locked after 5 failed code attempts.',
        body: {
          type: 'object',
          required: ['email', 'code'],
          properties: {
            email: {
              type: 'string',
              format: 'email',
              maxLength: 200,
              description: 'The email address the reset code was sent to.',
              example: 'jane@example.com',
            },
            code: {
              type: 'string',
              pattern: '^[0-9]{6}$',
              description: '6-digit code received via email.',
              example: '203847',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            required: ['ok', 'verifiedToken'],
            properties: {
              ok: { type: 'boolean', example: true },
              verifiedToken: {
                type: 'string',
                description: 'Short-lived JWT (2 min) that POST /auth/password/reset requires as proof the code was verified.',
                example: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lQGV4YW1wbGUuY29tIiwicHVycG9zZSI6InBhc3N3b3JkX3Jlc2V0X3ZlcmlmaWVkIn0.sig',
              },
            },
          },
          400: errorResponseWith(['bad_request', 'invalid_code', 'code_expired']),
          429: errorResponseWith(['too_many_attempts', 'rate_limit_exceeded']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      const email = normalizeEmail(req.body.email);
      const user = await User.findOne({ email });
      if (!user) return reply.code(400).send({ error: 'invalid_code' });

      // Per-account lockout survives /password/forgot re-issuance.
      if (user.resetLockedUntil && user.resetLockedUntil.getTime() > Date.now()) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }

      const record = await VerificationCode.findOne({
        userId: user._id,
        purpose: 'password_reset',
        consumed: false,
        expiresAt: { $gt: new Date() },
      }).sort({ createdAt: -1 });

      if (!record) return reply.code(400).send({ error: 'code_expired' });
      if (record.attempts >= MAX_ATTEMPTS) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      if (!safeCodeEqual(record.code, req.body.code)) {
        await VerificationCode.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
        user.resetFailedAttempts = (user.resetFailedAttempts ?? 0) + 1;
        if (user.resetFailedAttempts >= RESET_LOCKOUT_THRESHOLD) {
          user.resetLockedUntil = new Date(Date.now() + RESET_LOCKOUT_MS);
          user.resetFailedAttempts = 0;
        }
        await user.save();
        return reply.code(400).send({ error: 'invalid_code' });
      }

      // Issue a short-lived one-time token proving this code was verified.
      // /password/reset requires it so a valid code cannot be replayed
      // directly without first passing through this endpoint.
      const verifiedToken = app.jwt.sign(
        { sub: email, purpose: 'password_reset_verified' },
        { expiresIn: VERIFIED_TOKEN_TTL },
      );
      return { ok: true, verifiedToken };
    },
  );

  app.post<{ Body: { email: string; code: string; newPassword: string; verifiedToken: string } }>(
    '/password/reset',
    {
      ...tightLimit,
      schema: {
        tags: ['Auth'],
        summary: 'Reset password',
        description:
          "Verifies the reset code and the verifiedToken issued by POST /auth/password/verify-code, replaces the user's password hash, consumes the code, and returns a fresh signed JWT + user profile. Bumping the password also revokes all prior JWTs. The verifiedToken closes the replay gap: a raw code cannot be submitted here without first passing through /password/verify-code. Locked after 5 failed code attempts.",
        body: {
          type: 'object',
          required: ['email', 'code', 'newPassword', 'verifiedToken'],
          properties: {
            email: {
              type: 'string',
              format: 'email',
              maxLength: 200,
              description: 'The email address the reset flow was started for.',
              example: 'jane@example.com',
            },
            code: {
              type: 'string',
              pattern: '^[0-9]{6}$',
              description: '6-digit code received via email (same code used in /password/verify-code).',
              example: '203847',
            },
            newPassword: {
              type: 'string',
              pattern: PASSWORD_PATTERN,
              maxLength: 128,
              description: 'New password. At least 8 characters; must contain at least one letter and one digit.',
              example: 'NewSecret5678',
            },
            verifiedToken: {
              type: 'string',
              minLength: 20,
              maxLength: 2048,
              description: 'Short-lived JWT returned by POST /auth/password/verify-code.',
              example: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lQGV4YW1wbGUuY29tIiwicHVycG9zZSI6InBhc3N3b3JkX3Jlc2V0X3ZlcmlmaWVkIn0.sig',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: authResponse,
          400: errorResponseWith(['bad_request', 'invalid_code', 'code_expired']),
          429: errorResponseWith(['too_many_attempts', 'rate_limit_exceeded']),
          500: errorResponseWith(['internal_error']),
        },
      },
    },
    async (req, reply) => {
      // Validate the verifiedToken before touching the DB.
      let verifiedPayload: { sub: string; purpose: string };
      try {
        verifiedPayload = app.jwt.verify<{ sub: string; purpose: string }>(req.body.verifiedToken);
      } catch {
        return reply.code(400).send({ error: 'code_expired' });
      }
      if (verifiedPayload.purpose !== 'password_reset_verified') {
        return reply.code(400).send({ error: 'code_expired' });
      }

      const email = normalizeEmail(req.body.email);
      if (normalizeEmail(verifiedPayload.sub) !== email) {
        return reply.code(400).send({ error: 'invalid_code' });
      }

      const user = await User.findOne({ email });
      if (!user) return reply.code(400).send({ error: 'invalid_code' });

      // Per-account lockout survives /password/forgot re-issuance.
      if (user.resetLockedUntil && user.resetLockedUntil.getTime() > Date.now()) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }

      const record = await VerificationCode.findOne({
        userId: user._id,
        purpose: 'password_reset',
        consumed: false,
        expiresAt: { $gt: new Date() },
      }).sort({ createdAt: -1 });

      if (!record) return reply.code(400).send({ error: 'code_expired' });
      if (record.attempts >= MAX_ATTEMPTS) {
        return reply.code(429).send({ error: 'too_many_attempts' });
      }
      if (!safeCodeEqual(record.code, req.body.code)) {
        await VerificationCode.updateOne({ _id: record._id }, { $inc: { attempts: 1 } });
        user.resetFailedAttempts = (user.resetFailedAttempts ?? 0) + 1;
        if (user.resetFailedAttempts >= RESET_LOCKOUT_THRESHOLD) {
          user.resetLockedUntil = new Date(Date.now() + RESET_LOCKOUT_MS);
          user.resetFailedAttempts = 0;
        }
        await user.save();
        return reply.code(400).send({ error: 'invalid_code' });
      }

      user.passwordHash = await bcrypt.hash(req.body.newPassword, BCRYPT_ROUNDS);
      // Bumping passwordChangedAt revokes every JWT issued before this
      // moment — the auth preHandler refuses tokens whose iat is older.
      user.passwordChangedAt = new Date();
      // Successful reset clears the per-account brute-force lockout.
      user.resetFailedAttempts = 0;
      user.resetLockedUntil = null;
      record.consumed = true;
      await Promise.all([user.save(), record.save()]);

      const pca = Math.floor((user.passwordChangedAt?.getTime() ?? 0) / 1000);
      const token = app.jwt.sign({ sub: user.id as string, pca });
      return { token, user: toUserDTO(user) };
    },
  );
};

const toUserDTO = (u: InstanceType<typeof User>) => ({
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

export default authRoutes;
