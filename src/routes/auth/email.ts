import type { FastifyPluginAsync } from 'fastify';
import { codeSentResponse, errorResponseWith, userResponse } from '@/lib/schemas';
import { authService } from '@/services';
import { codeLimit, tightLimit, toUserDTO } from './shared.js';

const emailRoutes: FastifyPluginAsync = async (app) => {
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
              description:
                'Current password. Required when the account has a password set (hasPassword=true).',
              example: 'Secret1234',
            },
            idToken: {
              type: 'string',
              minLength: 20,
              maxLength: 4096,
              description:
                'Fresh Google ID token. Required when the account is Google-only (hasPassword=false).',
              example: 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ii4uLiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
            },
          },
          additionalProperties: false,
        },
        response: {
          200: userResponse,
          400: errorResponseWith([
            'bad_request',
            'password_required',
            'id_token_required',
            'code_expired',
            'invalid_code',
            'invalid_state',
          ]),
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
};

export default emailRoutes;
