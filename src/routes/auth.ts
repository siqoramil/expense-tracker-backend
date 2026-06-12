import type { FastifyPluginAsync } from 'fastify';
import {
  authResponse,
  codeSentResponse,
  errorResponseWith,
  userResponse,
} from '../lib/schemas.js';
import { normalizeEmail } from '../lib/normalize.js';
import type { User } from '../models/User.js';
import { authService, VERIFIED_TOKEN_TTL } from '../services/authService.js';

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
    async (req) => {
      const user = await authService.register(req.body, (err, label) =>
        app.log.error({ err }, label),
      );
      const pca = Math.floor((user.passwordChangedAt?.getTime() ?? 0) / 1000);
      const token = app.jwt.sign({ sub: user.id as string, pca });
      return { token, user: toUserDTO(user) };
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
    async (req) => {
      const user = await authService.login(req.body);
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
    async (req) => {
      const { user } = await authService.googleSignIn(req.body.idToken, (err, label) =>
        app.log.error({ err }, label),
      );
      const pca = Math.floor((user.passwordChangedAt?.getTime() ?? 0) / 1000);
      const token = app.jwt.sign({ sub: user.id as string, pca });
      return { token, user: toUserDTO(user) };
    },
  );

  // Explicit, authenticated linking of a Google identity onto the current
  // account. The caller must already be signed in with their password and
  // the Google ID token's email must match the account's email -- both
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
    async (req) => {
      const user = await authService.linkGoogle(req.user.sub, req.body.idToken);
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
    async (req) => {
      const user = await authService.getMe(req.user.sub);
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
    async (req) => {
      const user = await authService.updateMe(req.user.sub, req.body);
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
    async (req) => {
      return authService.requestDelete(req.user.sub);
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
      await authService.confirmDelete(req.user.sub, req.body);
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
    async (req) => {
      return authService.requestEmailChange(req.user.sub, req.body.newEmail);
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
    async (req) => {
      const user = await authService.verifyEmailChange(req.user.sub, req.body);
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
      return authService.forgotPassword(req.body.email);
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
    async (req) => {
      const { email } = await authService.verifyResetCode(req.body.email, req.body.code);
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

      const user = await authService.resetPassword(email, req.body.code, req.body.newPassword);
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
