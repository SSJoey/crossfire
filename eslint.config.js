import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'logs/**', 'assets/**', 'coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Indexed reads into fixed pools need `!` because tsconfig has noUncheckedIndexedAccess.
      '@typescript-eslint/no-non-null-assertion': 'off',
      eqeqeq: ['error', 'always'],
      'no-restricted-properties': [
        'error',
        { property: 'innerHTML', message: 'Names and user text must be rendered with textContent.' },
        { property: 'outerHTML', message: 'Names and user text must be rendered with textContent.' },
      ],
    },
  },
  {
    files: ['client/src/**/*.ts', 'tests/e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.browser } },
  },
  prettier,
);
