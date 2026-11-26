// Lint rules for the browser clients: the Node set plus the rules of hooks,
// which tsc cannot see and which fail silently at runtime.
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import node from './node.js';

export default [
  ...node,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
];
