import { OBJECT_ID_PATTERN, baseProps } from './common.js';

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
