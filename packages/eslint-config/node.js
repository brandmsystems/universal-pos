// Lint rules for Node packages (the API). Type-aware rules are deliberately
// not enabled: `tsc` with this repo's strict settings already owns types, and
// a lint pass that re-derives them doubles the CI time for no new signal.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      // `_`-prefixed parameters are the codebase's way of saying "unused on purpose".
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
);
