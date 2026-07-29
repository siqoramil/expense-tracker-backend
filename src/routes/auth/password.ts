import type { FastifyPluginAsync } from 'fastify';
import { normalizeEmail } from '@/lib';
import { authResponse, codeSentResponse, errorResponseWith } from '@/lib/schemas';
import { VERIFIED_TOKEN_TTL, authService } from '@/services';
import { PASSWORD_PATTERN, codeLimit, sessionResponse, tightLimit } from './shared.js';

const passwordRoutes: FastifyPluginAsync = async (app) => {
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
          'Checks that the supplied reset code is valid for the given email and returns a short-lived verifiedToken (exp=2 min) that POST /auth/password/reset requires. Requiring this token prevents the raw code from being replayed directly into the reset step. The token is not single-use: it stays valid for its full TTL, and /auth/password/reset still requires the raw code alongside it. Locked after 5 failed code attempts.',
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
                description:
                  'Short-lived JWT (2 min) that POST /auth/password/reset requires as proof the code was verified.',
                example:
                  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lQGV4YW1wbGUuY29tIiwicHVycG9zZSI6InBhc3N3b3JkX3Jlc2V0X3ZlcmlmaWVkIn0.sig',
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
      // Issue a short-lived token proving this code was verified.
      // /password/reset requires it so a valid code cannot be replayed
      // directly without first passing through this endpoint. It is not
      // single-use — it stays valid for its full 2-minute TTL — but on its
      // own it is not enough: /password/reset still requires the raw code.
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
              description:
                '6-digit code received via email (same code used in /password/verify-code).',
              example: '203847',
            },
            newPassword: {
              type: 'string',
              pattern: PASSWORD_PATTERN,
              maxLength: 128,
              description:
                'New password. At least 8 characters; must contain at least one letter and one digit.',
              example: 'NewSecret5678',
            },
            verifiedToken: {
              type: 'string',
              minLength: 20,
              maxLength: 2048,
              description: 'Short-lived JWT returned by POST /auth/password/verify-code.',
              example:
                'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqYW5lQGV4YW1wbGUuY29tIiwicHVycG9zZSI6InBhc3N3b3JkX3Jlc2V0X3ZlcmlmaWVkIn0.sig',
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
      return sessionResponse(app, user);
    },
  );
};

export default passwordRoutes;
