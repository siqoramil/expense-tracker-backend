// Shared OpenAPI / JSON Schema fragments for use across route files.
// Keep in sync with the Mongoose models in ../models.

export const OBJECT_ID_PATTERN = '^[0-9a-fA-F]{24}$';

export const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', pattern: OBJECT_ID_PATTERN } },
  additionalProperties: false,
} as const;

// ── Generic response shapes ──────────────────────────────────
export const errorResponse = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'string',
      description: 'Short snake_case error code, e.g. "invalid_credentials".',
    },
  },
} as const;

export const okResponse = {
  type: 'object',
  required: ['ok'],
  properties: { ok: { type: 'boolean', const: true } },
} as const;

export const codeSentResponse = {
  type: 'object',
  required: ['sent', 'expiresInSeconds'],
  properties: {
    sent: { type: 'boolean', const: true },
    expiresInSeconds: {
      type: 'number',
      description: 'Seconds until the verification code expires.',
    },
  },
} as const;

// ── Entities (response shapes) ───────────────────────────────
const baseProps = {
  _id: { type: 'string', pattern: OBJECT_ID_PATTERN },
  userId: { type: 'string', pattern: OBJECT_ID_PATTERN },
  createdAt: { type: 'string', format: 'date-time' },
  updatedAt: { type: 'string', format: 'date-time' },
};

const bilingualString = {
  type: 'object',
  properties: {
    en: { type: 'string' },
    uz: { type: 'string' },
  },
} as const;

export const userEntity = {
  type: 'object',
  required: ['id', 'email', 'name'],
  properties: {
    id: { type: 'string' },
    email: { type: 'string', format: 'email' },
    name: { type: 'string' },
    avatar: {
      type: 'string',
      description: 'Initials, https URL, or base64 data URI.',
    },
    pro: { type: 'boolean' },
    hasPassword: {
      type: 'boolean',
      description: 'Whether the user can sign in with email + password.',
    },
    hasGoogle: {
      type: 'boolean',
      description: 'Whether a Google identity is linked to this account.',
    },
    prefs: {
      type: 'object',
      properties: {
        lang: {
          type: 'string',
          enum: ['en', 'uz', 'ru', 'de', 'fr', 'es'],
        },
        currency: {
          type: 'string',
          enum: ['UZS', 'USD', 'EUR', 'GBP', 'RUB'],
        },
        dark: { type: 'boolean' },
        pin: { type: 'boolean' },
        notifications: { type: 'boolean' },
        biometric: { type: 'boolean' },
      },
    },
  },
} as const;

export const authResponse = {
  type: 'object',
  required: ['token', 'user'],
  properties: {
    token: { type: 'string', description: 'Signed JWT bearer token.' },
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
    cat: { type: 'string' },
    limit: { type: 'number' },
  },
} as const;

export const categoryEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    label: bilingualString,
    icon: { type: 'string' },
    color: { type: 'string' },
    kind: { type: 'string', enum: ['income', 'expense'] },
  },
} as const;

export const debtPaymentEntity = {
  type: 'object',
  properties: {
    _id: { type: 'string', pattern: OBJECT_ID_PATTERN },
    amount: { type: 'number' },
    date: { type: 'string' },
  },
} as const;

export const debtEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    direction: { type: 'string', enum: ['owe_me', 'i_owe'] },
    name: { type: 'string' },
    color: { type: 'string' },
    amount: { type: 'number' },
    paid: { type: 'number' },
    due: { type: 'string', description: 'Due date (YYYY-MM-DD).' },
    note: { type: 'string' },
    payments: { type: 'array', items: debtPaymentEntity },
    archived: { type: 'boolean' },
  },
} as const;

export const notificationEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    kind: {
      type: 'string',
      enum: ['overdue', 'budget', 'bill', 'income'],
    },
    title: bilingualString,
    body: bilingualString,
    date: { type: 'string' },
    read: { type: 'boolean' },
  },
} as const;

export const recurringEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    kind: { type: 'string', enum: ['income', 'expense'] },
    cat: { type: 'string', pattern: OBJECT_ID_PATTERN },
    wallet: { type: 'string', pattern: OBJECT_ID_PATTERN },
    amount: { type: 'number' },
    note: { type: 'string' },
    every: { type: 'string', enum: ['month', 'week'] },
    nextDate: { type: 'string' },
    enabled: { type: 'boolean' },
  },
} as const;

export const transactionEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    kind: { type: 'string', enum: ['income', 'expense'] },
    cat: { type: 'string' },
    wallet: { type: 'string', pattern: OBJECT_ID_PATTERN },
    amount: { type: 'number' },
    note: { type: 'string' },
    date: { type: 'string', description: 'YYYY-MM-DD' },
  },
} as const;

export const walletEntity = {
  type: 'object',
  properties: {
    ...baseProps,
    name: bilingualString,
    icon: { type: 'string' },
    color: { type: 'string' },
    balance: { type: 'number' },
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
