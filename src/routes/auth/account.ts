import type { FastifyPluginAsync } from 'fastify';
import { codeSentResponse, errorResponseWith } from '@/lib/schemas';
import { authService } from '@/services';
import { codeLimit, tightLimit } from './shared.js';

const accountRoutes: FastifyPluginAsync = async (app) => {
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
              description:
                'Current password. Required when the account has a password set (hasPassword=true).',
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
          204: {
            type: 'object',
            description: 'Account and all associated data permanently deleted.',
          },
          400: errorResponseWith([
            'bad_request',
            'password_required',
            'id_token_required',
            'code_expired',
            'invalid_code',
          ]),
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
};

export default accountRoutes;
