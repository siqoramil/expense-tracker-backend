// Shared OpenAPI / JSON Schema fragments for use across route files.
// Keep in sync with the Mongoose models in ../models.

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

// ── Entities (response shapes) ───────────────────────────────
const baseProps = {
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

const bilingualString = {
  type: 'object',
  properties: {
    en: { type: 'string', example: 'Food' },
    uz: { type: 'string', example: 'Oziq-ovqat' },
  },
} as const;

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

export const budgetEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    cat: {
      type: 'string',
      pattern: OBJECT_ID_PATTERN,
      description: 'Category ObjectId this budget applies to.',
      example: '64a1f2e3b4c5d6e7f8a9b0c3',
    },
    limit: {
      type: 'number',
      description: 'Monthly spending limit in the user preferred currency.',
      example: 500,
    },
  },
} as const;

export const categoryEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    label: bilingualString,
    icon: { type: 'string', description: 'Icon identifier slug.', example: 'food' },
    color: { type: 'string', description: 'Hex color string.', example: '#FF6B6B' },
    kind: {
      type: 'string',
      enum: ['income', 'expense'],
      description: 'Whether this category is for income or expense transactions.',
      example: 'expense',
    },
  },
} as const;

export const debtPaymentEntity = {
  type: 'object',
  properties: {
    _id: {
      type: 'string',
      pattern: OBJECT_ID_PATTERN,
      description: 'Payment record id.',
      example: '64a1f2e3b4c5d6e7f8a9b0c4',
    },
    amount: { type: 'number', description: 'Amount paid.', example: 50 },
    date: { type: 'string', description: 'Payment date (YYYY-MM-DD).', example: '2026-01-20' },
  },
} as const;

export const debtEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    direction: {
      type: 'string',
      enum: ['owe_me', 'i_owe'],
      description: '"owe_me" means someone owes the user; "i_owe" means the user owes someone.',
      example: 'owe_me',
    },
    name: { type: 'string', description: 'Counterparty name.', example: 'Alex' },
    color: { type: 'string', description: 'UI accent color.', example: '#4ECDC4' },
    amount: { type: 'number', description: 'Total debt amount.', example: 200 },
    paid: { type: 'number', description: 'Amount paid so far.', example: 50 },
    due: { type: 'string', description: 'Due date (YYYY-MM-DD).', example: '2026-03-01' },
    note: { type: 'string', description: 'Optional free-text note.', example: 'Borrowed for rent' },
    payments: { type: 'array', items: debtPaymentEntity },
    archived: { type: 'boolean', description: 'Whether the debt is archived.', example: false },
  },
} as const;

export const notificationEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    kind: {
      type: 'string',
      enum: ['overdue', 'budget', 'bill', 'income'],
      description: 'Type of server-side event that triggered this notification.',
      example: 'budget',
    },
    title: {
      type: 'object',
      properties: {
        en: { type: 'string', example: 'Budget exceeded' },
        uz: { type: 'string', example: 'Byudjet oshib ketdi' },
      },
    },
    body: {
      type: 'object',
      properties: {
        en: { type: 'string', example: 'You have exceeded your Food budget for January.' },
        uz: { type: 'string', example: 'Yanvar oyi uchun Oziq-ovqat byudjetingiz oshib ketdi.' },
      },
    },
    date: { type: 'string', description: 'Event date (YYYY-MM-DD or ISO).', example: '2026-01-31' },
    read: {
      type: 'boolean',
      description: 'Whether the user has read this notification.',
      example: false,
    },
  },
} as const;

export const recurringEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    kind: {
      type: 'string',
      enum: ['income', 'expense'],
      description: 'Whether this recurring entry is income or expense.',
      example: 'expense',
    },
    cat: {
      type: 'string',
      pattern: OBJECT_ID_PATTERN,
      description: 'Category ObjectId.',
      example: '64a1f2e3b4c5d6e7f8a9b0c3',
    },
    wallet: {
      type: 'string',
      pattern: OBJECT_ID_PATTERN,
      description: 'Wallet ObjectId.',
      example: '64a1f2e3b4c5d6e7f8a9b0c5',
    },
    amount: { type: 'number', description: 'Amount per occurrence.', example: 30 },
    note: { type: 'string', description: 'Optional note.', example: 'Netflix subscription' },
    every: {
      type: 'string',
      enum: ['month', 'week'],
      description: 'Recurrence frequency.',
      example: 'month',
    },
    nextDate: {
      type: 'string',
      description: 'Next scheduled date (YYYY-MM-DD).',
      example: '2026-02-01',
    },
    enabled: { type: 'boolean', description: 'Whether the schedule is active.', example: true },
  },
} as const;

export const transactionEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    kind: {
      type: 'string',
      enum: ['income', 'expense'],
      description: 'Whether this is an income or expense transaction.',
      example: 'expense',
    },
    cat: {
      type: 'string',
      description: 'Category ObjectId.',
      example: '64a1f2e3b4c5d6e7f8a9b0c3',
    },
    wallet: {
      type: 'string',
      pattern: OBJECT_ID_PATTERN,
      description: 'Wallet ObjectId.',
      example: '64a1f2e3b4c5d6e7f8a9b0c5',
    },
    amount: { type: 'number', description: 'Transaction amount (non-negative).', example: 12.5 },
    note: { type: 'string', description: 'Optional free-text note.', example: 'Lunch at cafe' },
    date: { type: 'string', description: 'Transaction date (YYYY-MM-DD).', example: '2026-01-15' },
  },
} as const;

export const walletEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    name: {
      type: 'object',
      properties: {
        en: { type: 'string', example: 'Cash' },
        uz: { type: 'string', example: 'Naqd pul' },
      },
    },
    icon: { type: 'string', description: 'Icon identifier slug.', example: 'wallet' },
    color: { type: 'string', description: 'Hex color string.', example: '#2ECC71' },
    balance: {
      type: 'number',
      description:
        'Current balance. Derived from transaction writes; do not set directly via PATCH.',
      example: 1250.75,
    },
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
