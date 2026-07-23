import { OBJECT_ID_PATTERN, baseProps } from './common.js';

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
