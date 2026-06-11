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
  errorResponse,
  userResponse,
} from '../lib/schemas.js';
import { DUMMY_PASSWORD_HASH, safeCodeEqual } from '../lib/security.js';
import { seedDefaultCategories } from '../lib/defaultCategories.js';
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
        summary: 'Register a new account',
        description:
          'Creates a user with email/password credentials. Returns a signed JWT and the user profile. Rate limited to 10 req/min per IP.',
        body: {
          type: 'object',
          required: ['email', 'password', 'name'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 200 },
            password: {
              type: 'string',
              pattern: PASSWORD_PATTERN,
              maxLength: 128,
              description: '≥ 8 chars; must contain at least one letter and one digit.',
            },
            name: { type: 'string', minLength: 1, maxLength: 80 },
          },
          additionalProperties: false,
        },
        response: {
          200: authResponse,
          400: errorResponse,
          409: errorResponse,
          429: errorResponse,
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
        summary: 'Sign in with email + password',
        description:
          'Authenticates an existing user. Returns a signed JWT and the user profile on success. Rate limited to 10 req/min per IP. After 5 consecutive failed attempts the account is locked for 15 minutes (423).',
        body: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: { type: 'string', maxLength: 200 },
            password: { type: 'string', maxLength: 128 },
          },
          additionalProperties: false,
        },
        response: {
          200: authResponse,
          400: errorResponse,
          401: errorResponse,
          423: errorResponse,
          429: errorResponse,
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
        summary: 'Sign in with Google',
        description:
          "Verifies a Google ID token, then creates or links a local user account and returns a signed JWT. Returns 503 when Google sign-in isn't configured on the server.",
        body: {
          type: 'object',
          required: ['idToken'],
          properties: {
            idToken: {
              type: 'string',
              minLength: 20,
              maxLength: 4096,
              description: 'Google-issued ID token from the client SDK.',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: authResponse,
          400: errorResponse,
          401: errorResponse,
          429: errorResponse,
          503: errorResponse,
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
        summary: 'Link Google to current account',
        description:
          "Attaches a Google sub to the authenticated user. The Google ID token's email must match the account's email. Returns 409 if the Google sub is already linked elsewhere.",
        body: {
          type: 'object',
          required: ['idToken'],
          properties: {
            idToken: { type: 'string', minLength: 20, maxLength: 4096 },
          },
          additionalProperties: false,
        },
        response: {
          200: userResponse,
          400: errorResponse,
          401: errorResponse,
          409: errorResponse,
          429: errorResponse,
          503: errorResponse,
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
        summary: 'Get current user',
        description: 'Returns the profile of the authenticated user.',
        response: {
          200: userResponse,
          401: errorResponse,
          404: errorResponse,
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
        summary: 'Update current user',
        description:
          "Patches the user's name, avatar, and/or preferences. Avatars must be empty, 1–2 char initials, an https URL, or a base64 data URI for jpeg/png/webp/gif (SVG is rejected).",
        body: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            avatar: {
              type: 'string',
              // ~600KB ceiling: enough for the mobile picker's 0.3-quality
              // 1:1 crops (~150-300KB base64) without bloating User docs.
              // TODO: move to S3/CDN and store only a URL — Mongo's 16MB
              // doc cap and oplog amplification make inline images a
              // foot-gun at scale.
              maxLength: 600_000,
              description:
                'Initials, https URL, or base64 image data URI (jpeg/png/webp/gif). Cap ~600KB.',
            },
            prefs: {
              type: 'object',
              properties: {
                lang: { type: 'string', enum: ['en', 'uz', 'ru', 'de', 'fr', 'es'] },
                currency: { type: 'string', enum: ['UZS', 'USD', 'EUR', 'GBP', 'RUB'] },
                dark: { type: 'boolean' },
                pin: { type: 'boolean' },
                notifications: { type: 'boolean' },
                biometric: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        response: {
          200: userResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
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
        summary: 'Request account deletion code',
        description:
          'Generates a 6-digit code, emails it to the account owner, and stores it for confirmation. Codes expire after 10 minutes. Rate limited to 5 req/min per IP.',
        response: {
          200: codeSentResponse,
          401: errorResponse,
          404: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });

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
        summary: 'Confirm account deletion',
        description:
          'Verifies the 6-digit code from /account/request-delete AND re-authenticates the caller (password for password accounts, fresh Google ID token for Google-only accounts), then permanently deletes the user along with all of their data. Returns 204 on success. Locked after 5 failed attempts.',
        body: {
          type: 'object',
          required: ['code'],
          properties: {
            code: {
              type: 'string',
              pattern: '^[0-9]{6}$',
              description: '6-digit numeric code emailed to the user.',
            },
            password: {
              type: 'string',
              maxLength: 128,
              description: 'Current password. Required when the account has a password set.',
            },
            idToken: {
              type: 'string',
              minLength: 20,
              maxLength: 4096,
              description:
                'Fresh Google ID token. Required when the account is Google-only (no password).',
            },
          },
          additionalProperties: false,
        },
        response: {
          204: { type: 'object', description: 'Account and all data deleted.' },
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          423: errorResponse,
          429: errorResponse,
          503: errorResponse,
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
        summary: 'Request email change code',
        description:
          'Sends a 6-digit code to the proposed new email address so the user can prove ownership. The response is identical whether or not the target address is already registered, to avoid leaking account existence to an authenticated caller. Codes expire after 10 minutes. Rate limited to 5 req/min per IP.',
        body: {
          type: 'object',
          required: ['newEmail'],
          properties: {
            newEmail: { type: 'string', format: 'email', maxLength: 200 },
          },
          additionalProperties: false,
        },
        response: {
          200: codeSentResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          429: errorResponse,
          503: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const newEmail = normalizeEmail(req.body.newEmail);
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      if (user.email === newEmail) return reply.code(400).send({ error: 'same_email' });

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
        summary: 'Verify email change',
        description:
          'Confirms the 6-digit code emailed to the new address AND re-authenticates the caller (password for password accounts, fresh Google ID token for Google-only accounts) before applying the change. A stolen JWT plus a one-time peek at the inbox must not be enough to take over the account. Locked after 5 failed attempts.',
        body: {
          type: 'object',
          required: ['code'],
          properties: {
            code: { type: 'string', pattern: '^[0-9]{6}$' },
            password: {
              type: 'string',
              maxLength: 128,
              description: 'Current password. Required when the account has a password set.',
            },
            idToken: {
              type: 'string',
              minLength: 20,
              maxLength: 4096,
              description: 'Fresh Google ID token. Required when the account is Google-only.',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: userResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          409: errorResponse,
          423: errorResponse,
          429: errorResponse,
          503: errorResponse,
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
        summary: 'Send password reset code',
        description:
          'Sends a 6-digit reset code to the email if an account exists. The response is identical whether or not the email is registered, to avoid leaking account existence. Rate limited to 5 req/min per IP.',
        body: {
          type: 'object',
          required: ['email'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 200 },
          },
          additionalProperties: false,
        },
        response: {
          200: codeSentResponse,
          400: errorResponse,
          429: errorResponse,
        },
      },
    },
    async (req) => {
      const email = normalizeEmail(req.body.email);
      const user = await User.findOne({ email });
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
        summary: 'Verify password reset code',
        description:
          'Checks that the supplied reset code is valid for the given email and returns a short-lived verified token (exp=2min) required by /password/reset. Using a one-time token prevents the unchecked code from being replayed directly into the reset step. Locked after 5 failed attempts.',
        body: {
          type: 'object',
          required: ['email', 'code'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 200 },
            code: { type: 'string', pattern: '^[0-9]{6}$' },
          },
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              verifiedToken: { type: 'string', description: 'Short-lived JWT (2min) gating /password/reset.' },
            },
          },
          400: errorResponse,
          429: errorResponse,
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
        summary: 'Reset password',
        description:
          "Verifies the reset code and the verifiedToken issued by /password/verify-code, replaces the user's password hash, consumes the code, and returns a fresh signed JWT with the user profile. The verifiedToken closes the replay gap: a raw code cannot be submitted here without first passing through /password/verify-code. Locked after 5 failed attempts.",
        body: {
          type: 'object',
          required: ['email', 'code', 'newPassword', 'verifiedToken'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 200 },
            code: { type: 'string', pattern: '^[0-9]{6}$' },
            newPassword: {
              type: 'string',
              pattern: PASSWORD_PATTERN,
              maxLength: 128,
              description: '≥ 8 chars; must contain at least one letter and one digit.',
            },
            verifiedToken: {
              type: 'string',
              minLength: 20,
              maxLength: 2048,
              description: 'Short-lived JWT returned by /password/verify-code.',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: authResponse,
          400: errorResponse,
          429: errorResponse,
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
