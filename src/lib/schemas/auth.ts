export const userEntity = {
  type: 'object',
  required: ['id', 'email', 'name'],
  properties: {
    id: { type: 'string', description: 'Unique user id.', example: '64a1f2e3b4c5d6e7f8a9b0c1' },
    email: { type: 'string', format: 'email', example: 'user@example.com' },
    name: { type: 'string', example: 'Jane Doe' },
    avatar: {
      type: 'string',
      description: 'Initials, https URL, or base64 data URI.',
      example: 'JD',
    },
    pro: { type: 'boolean', example: false },
    hasPassword: {
      type: 'boolean',
      description: 'Whether the user can sign in with email + password.',
      example: true,
    },
    hasGoogle: {
      type: 'boolean',
      description: 'Whether a Google identity is linked to this account.',
      example: false,
    },
    prefs: {
      type: 'object',
      properties: {
        lang: {
          type: 'string',
          enum: ['en', 'uz', 'ru', 'de', 'fr', 'es'],
          example: 'en',
        },
        currency: {
          type: 'string',
          enum: ['UZS', 'USD', 'EUR', 'GBP', 'RUB'],
          example: 'USD',
        },
        dark: { type: 'boolean', example: false },
        pin: { type: 'boolean', example: false },
        notifications: { type: 'boolean', example: true },
        biometric: { type: 'boolean', example: false },
      },
    },
  },
} as const;

export const authResponse = {
  type: 'object',
  required: ['token', 'user'],
  properties: {
    token: {
      type: 'string',
      description: 'Signed JWT bearer token. Include as: Authorization: Bearer <token>.',
      example:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI2NGExZjJlM2I0YzVkNmU3ZjhhOWIwYzEifQ.sig',
    },
    user: userEntity,
  },
} as const;

export const userResponse = {
  type: 'object',
  required: ['user'],
  properties: { user: userEntity },
} as const;
