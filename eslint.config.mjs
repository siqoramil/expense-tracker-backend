// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Global ignores
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },

  // Base JS recommended
  js.configs.recommended,

  // TypeScript recommended (type-checked via projectService)
  ...tseslint.configs.recommendedTypeChecked,

  // Project service config for type-aware rules
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Allow files not explicitly listed in tsconfig (config file, test files,
          // vitest config) to still be type-checked with default tsconfig settings.
          allowDefaultProject: ['eslint.config.mjs', 'tests/*.ts', 'vitest.config.ts'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
    rules: {
      'no-console': 'warn',
      // Fastify plugin functions are typed as async but may not always top-level await.
      // The rule fires on the outer plugin function even though handlers inside do await.
      '@typescript-eslint/require-await': 'off',
      // Consistent type imports keep the build clean
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      // Unhandled promise rejections are bugs — enforce explicit handling.
      '@typescript-eslint/no-floating-promises': 'error',
      // Fastify uses `throw reply.code(N).send(body)` inside transaction callbacks
      // to abort early and set the response in one step. reply.send() returns
      // FastifyReply (not an Error), but the throw is deliberate and well-understood.
      '@typescript-eslint/only-throw-error': 'off',
    },
  },

  // Relax type-checked rules for test and config files where strict typing is noise
  {
    files: ['tests/**/*.ts', 'vitest.config.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
    },
  },

  // Prettier MUST be last — disables all formatting rules
  prettier,
);
