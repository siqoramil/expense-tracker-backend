import { baseProps } from './common.js';

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
