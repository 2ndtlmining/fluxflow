import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'build/',
      'dist/',
      '.svelte-kit/',
      'node_modules/',
      'coverage/',
      'static/',
      'src/lib/services/**',
      'src/lib/config.js',
      'server.js'
    ]
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs['flat/recommended'],
  prettier,
  ...svelte.configs['flat/prettier'],

  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      }
    }
  },

  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser
      }
    }
  },

  // Server code: enforce explicit, unambiguous imports.
  {
    files: ['src/lib/server/**/*.ts', 'src/server.ts'],
    rules: {
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' }
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },

  // Client code: console is still noisy but not an error during the migration.
  {
    files: ['src/lib/**/*.js', 'src/routes/**/*.js'],
    rules: {
      'no-console': 'off'
    }
  }
);
