import { OBJECT_ID_PATTERN, baseProps } from './common.js';

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
