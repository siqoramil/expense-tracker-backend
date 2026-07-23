import type { FastifyPluginAsync } from 'fastify';
import { authResponse, errorResponseWith, userResponse } from '@/lib/schemas';
import { authService } from '@/services';
import { PASSWORD_PATTERN, sessionResponse, tightLimit, toUserDTO } from './shared.js';

const sessionRoutes: FastifyPluginAsync = async (app) => {
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
      return sessionResponse(app, user);
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
      return sessionResponse(app, user);
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
          'Verifies a Google ID token, then creates or links a local user account and returns a signed JWT. Returns 503 when Google sign-in is not configured on the server. Returns 409 when the Google email matches an existing password-only account that has not yet explicitly linked Google (use POST /auth/google/link instead).',
        body: {
          type: 'object',
          required: ['idToken'],
          properties: {
            idToken: {
              type: 'string',
              minLength: 20,
              maxLength: 4096,
              description:
                'Google-issued ID token obtained from the client SDK (sign_in_with_credential).',
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
      return sessionResponse(app, user);
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
};

export default sessionRoutes;
