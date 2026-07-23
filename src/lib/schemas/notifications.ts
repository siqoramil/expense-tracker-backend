import { baseProps } from './common.js';

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
