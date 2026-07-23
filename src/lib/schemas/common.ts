export const OBJECT_ID_PATTERN = '^[0-9a-fA-F]{24}$';

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      pattern: OBJECT_ID_PATTERN,
      description: '24-hex MongoDB ObjectId.',
      example: '64a1f2e3b4c5d6e7f8a9b0c1',
    },
  },
  additionalProperties: false,
} as const;

// ── Generic response shapes ──────────────────────────────────
export const errorResponse = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'string',
      description: 'Short snake_case error code.',
      example: 'not_found',
    },
  },
} as const;

// Specialised error response that documents the exact codes an endpoint
// can emit. Use errorResponseWith(['code_a', 'code_b']) in per-route schemas
// so the Swagger UI description enumerates every possible code.
export const errorResponseWith = (codes: readonly string[]) => ({
  type: 'object' as const,
  required: ['error'] as const,
  properties: {
    error: {
      type: 'string' as const,
      description: `Possible values: ${codes.join(' | ')}.`,
      example: codes[0],
    },
  },
});

export const okResponse = {
  type: 'object',
  required: ['ok'],
  properties: { ok: { type: 'boolean', const: true, example: true } },
} as const;

export const codeSentResponse = {
  type: 'object',
  required: ['sent', 'expiresInSeconds'],
  properties: {
    sent: { type: 'boolean', const: true, example: true },
    expiresInSeconds: {
      type: 'number',
      description: 'Seconds until the verification code expires.',
      example: 600,
    },
  },
} as const;

// ── Entity building blocks ───────────────────────────────────
export const baseProps = {
  _id: {
    type: 'string',
    pattern: OBJECT_ID_PATTERN,
    description: '24-hex MongoDB ObjectId.',
    example: '64a1f2e3b4c5d6e7f8a9b0c1',
  },
  userId: {
    type: 'string',
    pattern: OBJECT_ID_PATTERN,
    description: 'Owner user id.',
    example: '64a1f2e3b4c5d6e7f8a9b0c2',
  },
  createdAt: { type: 'string', format: 'date-time', example: '2026-01-15T10:00:00.000Z' },
  updatedAt: { type: 'string', format: 'date-time', example: '2026-01-15T10:00:00.000Z' },
};

export const bilingualString = {
  type: 'object',
  properties: {
    en: { type: 'string', example: 'Food' },
    uz: { type: 'string', example: 'Oziq-ovqat' },
  },
} as const;

// ── Wrapper helpers ──────────────────────────────────────────
export const itemResponse = (item: object) => ({
  type: 'object' as const,
  required: ['item'],
  properties: { item },
});

export const itemsResponse = (item: object) => ({
  type: 'object' as const,
  required: ['items'],
  properties: { items: { type: 'array' as const, items: item } },
});
