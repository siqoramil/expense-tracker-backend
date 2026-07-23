import type { FastifyPluginAsync } from 'fastify';
import { errorResponseWith, userResponse } from '@/lib/schemas';
import { authService } from '@/services';
import { toUserDTO } from './shared.js';

const profileRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/me',
    {
      preHandler: app.auth,
      schema: {
        tags: ['Auth'],
        summary: 'Get current user',
        description:
          'Returns the profile of the authenticated user. The 404 case occurs when the JWT is valid but the user document was deleted between token issuance and this call.',
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
                notifications: {
                  type: 'boolean',
                  description: 'Push notifications enabled.',
                  example: true,
                },
                biometric: {
                  type: 'boolean',
                  description: 'Biometric unlock enabled.',
                  example: false,
                },
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
};

export default profileRoutes;
