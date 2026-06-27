import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.strict, ...tseslint.configs.stylistic],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Match CLAUDE.md: named exports only (config files are exempted below).
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use named exports; no default exports.',
        },
      ],
    },
  },
  {
    // Tooling config files conventionally require a default export.
    files: ['**/*.config.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Tests use focused non-null assertions on known-present mock data.
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
