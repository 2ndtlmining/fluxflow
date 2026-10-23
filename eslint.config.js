import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: ['build/', 'dist/', '.svelte-kit/', 'node_modules/', 'coverage/', 'static/']
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
    files: ['src/lib/server/**/*.ts', 'src/server.ts', 'scripts/**/*.ts'],
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

  // Outbound HTTP goes through `http.ts`, which puts a timeout on every request (#10). A bare
  // `fetch` elsewhere in the server would bring back the hang that stalled v1's sync.
  {
    files: ['src/lib/server/**/*.ts', 'src/server.ts'],
    ignores: ['src/lib/server/http.ts', 'src/lib/server/**/*.test.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'Use httpRequest/httpJson from http.ts, which time out (#10).' }
      ]
    }
  },

  // Browser code: logging to the console is still noisy, but not an error.
  {
    files: ['src/lib/**/*.js', 'src/routes/**/*.js', 'src/lib/**/*.svelte'],
    rules: {
      'no-console': 'off'
    }
  }
);
