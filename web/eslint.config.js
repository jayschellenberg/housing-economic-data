import js from '@eslint/js';
import globals from 'globals';

// Pragmatic flat config for a solo-maintained vanilla-JS app: the recommended
// rules (real-bug catchers — no-undef, no-dupe-keys, no-unreachable, …) as
// errors, unused vars as a warning, console allowed. Not a style enforcer.
export default [
  { ignores: ['dist/**', 'node_modules/**', '**/*.tmp.*'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js', 'test/**/*.js', '*.config.js', 'rental/**/*.js', 'commercial/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      // __APP_COMMIT__ / __APP_BUILD_TIME__ are build-time defines used by
      // the Rental and Commercial sub-apps (vite.config.js).
      globals: { ...globals.browser, ...globals.node, __APP_COMMIT__: 'readonly', __APP_BUILD_TIME__: 'readonly' },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  // The sub-apps use a non-breaking space inside a UI string on purpose.
  {
    files: ['rental/**/*.js', 'commercial/**/*.js'],
    rules: { 'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }] },
  },
];
