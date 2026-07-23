import { baseProps, bilingualString } from './common.js';

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
