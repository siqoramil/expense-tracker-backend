import { OBJECT_ID_PATTERN, baseProps } from './common.js';

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
