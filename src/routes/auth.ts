import bcrypt from 'bcryptjs';
import type { FastifyPluginAsync } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { env } from '../lib/env.js';
import { generateCode, sendVerificationCode } from '../lib/mailer.js';
import {
  authResponse,
  codeSentResponse,
  errorResponse,
  okResponse,
  userResponse,
} from '../lib/schemas.js';
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

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// At least 8 chars, must contain a letter and a digit.
const PASSWORD_PATTERN = '^(?=.*[A-Za-z])(?=.*\\d).{8,128}$';

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
      const { email, password, name } = req.body;
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) return reply.code(409).send({ error: 'email_taken' });

      const passwordHash = await bcrypt.hash(password, 10);
      const avatar = initialsFrom(name);
      const user = await User.create({ email, passwordHash, name, avatar });
      const token = app.jwt.sign({ sub: user.id });
      return { token, user: toUserDTO(user) };
    },
  );

  app.post<{ Body: { email: string; password: string } }>(
    '/login',
    {
      ...tightLimit,
      schema: {
        summary: 'Sign in with email + password',
        description:
          'Authenticates an existing user. Returns a signed JWT and the user profile on success. Rate limited to 10 req/min per IP.',
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
          429: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const { email, password } = req.body;
      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user || !user.passwordHash) {
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      const ok = await bcrypt.compare(password, user.passwordHash);
      if (!ok) return reply.code(401).send({ error: 'invalid_credentials' });
      const token = app.jwt.sign({ sub: user.id });
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

      const email = payload.email.toLowerCase();
      const name = payload.name || payload.given_name || email.split('@')[0];
      const picture = payload.picture ?? '';

      let user = await User.findOne({ $or: [{ googleId: payload.sub }, { email }] });
      if (!user) {
        user = await User.create({
          email,
          name,
          googleId: payload.sub,
          avatar: picture || initialsFrom(name),
          passwordHash: '',
        });
      } else {
        let dirty = false;
        if (!user.googleId) {
          user.googleId = payload.sub;
          dirty = true;
        }
        if (!user.avatar && picture) {
          user.avatar = picture;
          dirty = true;
        }
        if (dirty) await user.save();
      }

      const token = app.jwt.sign({ sub: user.id });
      return { token, user: toUserDTO(user) };
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
              maxLength: 8_000_000,
              description:
                'Initials, https URL, or base64 image data URI (jpeg/png/webp/gif).',
            },
            prefs: { type: 'object', additionalProperties: true },
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

      await sendVerificationCode(user.email, code, 'account deletion');
      return { sent: true, expiresInSeconds: CODE_TTL_MS / 1000 };
    },
  );

  app.post<{ Body: { code: string } }>(
    '/account/confirm-delete',
    {
      ...tightLimit,
      preHandler: app.auth,
      schema: {
        summary: 'Confirm account deletion',
        description:
          'Verifies the 6-digit code from /account/request-delete and permanently deletes the user along with all of their data (transactions, budgets, categories, debts, notifications, recurring entries, wallets, verification codes). Returns 204 on success. Locked after 5 failed attempts.',
        body: {
          type: 'object',
          required: ['code'],
          properties: {
            code: {
              type: 'string',
              pattern: '^[0-9]{6}$',
              description: '6-digit numeric code emailed to the user.',
            },
          },
          additionalProperties: false,
        },
        response: {
          204: { type: 'object', description: 'Account and all data deleted.' },
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          429: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });

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
      if (record.code !== req.body.code) {
        record.attempts += 1;
        await record.save();
        return reply.code(400).send({ error: 'invalid_code' });
      }

      const userId = user._id;
      await Promise.all([
        Transaction.deleteMany({ userId }),
        Budget.deleteMany({ userId }),
        Category.deleteMany({ userId }),
        Debt.deleteMany({ userId }),
        Notification.deleteMany({ userId }),
        Recurring.deleteMany({ userId }),
        Wallet.deleteMany({ userId }),
        VerificationCode.deleteMany({ userId }),
      ]);
      await user.deleteOne();

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
          'Sends a 6-digit code to the proposed new email address so the user can prove ownership. Codes expire after 10 minutes. Rate limited to 5 req/min per IP.',
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
          409: errorResponse,
          429: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const newEmail = req.body.newEmail.toLowerCase().trim();
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });
      if (user.email === newEmail) return reply.code(400).send({ error: 'same_email' });
      const taken = await User.findOne({ email: newEmail });
      if (taken) return reply.code(409).send({ error: 'email_taken' });

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

      await sendVerificationCode(newEmail, code, 'email change');
      return { sent: true, expiresInSeconds: CODE_TTL_MS / 1000 };
    },
  );

  app.post<{ Body: { code: string } }>(
    '/email/verify-change',
    {
      ...tightLimit,
      preHandler: app.auth,
      schema: {
        summary: 'Verify email change',
        description:
          'Confirms the 6-digit code emailed to the new address and updates the user record. Locked after 5 failed attempts.',
        body: {
          type: 'object',
          required: ['code'],
          properties: { code: { type: 'string', pattern: '^[0-9]{6}$' } },
          additionalProperties: false,
        },
        response: {
          200: userResponse,
          400: errorResponse,
          401: errorResponse,
          404: errorResponse,
          409: errorResponse,
          429: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const user = await User.findById(req.user.sub);
      if (!user) return reply.code(404).send({ error: 'not_found' });

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

      if (record.code !== req.body.code) {
        record.attempts += 1;
        await record.save();
        return reply.code(400).send({ error: 'invalid_code' });
      }

      if (!record.newEmail) return reply.code(400).send({ error: 'invalid_state' });
      const stillTaken = await User.findOne({ email: record.newEmail });
      if (stillTaken && stillTaken.id !== user.id) {
        return reply.code(409).send({ error: 'email_taken' });
      }

      user.email = record.newEmail;
      record.consumed = true;
      await Promise.all([user.save(), record.save()]);

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
          "Sends a 6-digit reset code to the email if an account exists. The response is identical whether or not the email is registered, to avoid leaking account existence. Rate limited to 5 req/min per IP.",
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
      const email = req.body.email.toLowerCase().trim();
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
        await sendVerificationCode(email, code, 'password reset');
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
          "Checks that the supplied reset code is valid for the given email — does not consume it. Useful for two-step UIs where the user enters the code before typing a new password. Locked after 5 failed attempts.",
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
          200: okResponse,
          400: errorResponse,
          429: errorResponse,
        },
      },
    },
    async (req, reply) => {
      const email = req.body.email.toLowerCase().trim();
      const user = await User.findOne({ email });
      if (!user) return reply.code(400).send({ error: 'invalid_code' });

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
      if (record.code !== req.body.code) {
        record.attempts += 1;
        await record.save();
        return reply.code(400).send({ error: 'invalid_code' });
      }
      return { ok: true };
    },
  );

  app.post<{ Body: { email: string; code: string; newPassword: string } }>(
    '/password/reset',
    {
      ...tightLimit,
      schema: {
        summary: 'Reset password',
        description:
          "Verifies the reset code, replaces the user's password hash, consumes the code, and returns a fresh signed JWT with the user profile. Locked after 5 failed attempts.",
        body: {
          type: 'object',
          required: ['email', 'code', 'newPassword'],
          properties: {
            email: { type: 'string', format: 'email', maxLength: 200 },
            code: { type: 'string', pattern: '^[0-9]{6}$' },
            newPassword: {
              type: 'string',
              pattern: PASSWORD_PATTERN,
              maxLength: 128,
              description: '≥ 8 chars; must contain at least one letter and one digit.',
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
      const email = req.body.email.toLowerCase().trim();
      const user = await User.findOne({ email });
      if (!user) return reply.code(400).send({ error: 'invalid_code' });

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
      if (record.code !== req.body.code) {
        record.attempts += 1;
        await record.save();
        return reply.code(400).send({ error: 'invalid_code' });
      }

      user.passwordHash = await bcrypt.hash(req.body.newPassword, 10);
      record.consumed = true;
      await Promise.all([user.save(), record.save()]);

      const token = app.jwt.sign({ sub: user.id });
      return { token, user: toUserDTO(user) };
    },
  );
};

const toUserDTO = (u: InstanceType<typeof User>) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  avatar: u.avatar,
  pro: u.pro,
  prefs: u.prefs,
});

export default authRoutes;
