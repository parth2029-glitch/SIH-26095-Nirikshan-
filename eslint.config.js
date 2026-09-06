import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-config-prettier';

/** One shared config for every workspace. */
export default [
  {
    ignores: [
      'node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.expo/**',
      'fixtures/**',
      'coverage/**',
    ],
  },
  js.configs.recommended,

  // Node code: API, scripts, tests, config.
  {
    files: ['apps/api/**/*.js', 'scripts/**/*.js', 'tests/**/*.js', '*.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Express recognises an error handler by its four-arg signature, so
      // `next` must be declared even when unused.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],

      // §6 — bulkWrite is the one mutation path Mongoose cannot hook, so the
      // requireOverride plugin cannot refuse it. Banned here instead, because a
      // silent bypass of the ledger is the failure F4 exists to prevent.
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression > MemberExpression[property.name='bulkWrite']",
          message:
            'bulkWrite bypasses the requireOverride hooks (§6) — use recordOverride(), or insertMany for creates.',
        },
      ],
    },
  },

  // packages/core must stay platform-neutral: it runs in Node, a Vite build and
  // a Metro bundle (§3). No node built-ins, no browser globals, no I/O.
  {
    files: ['packages/core/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {}, // nothing ambient — not even `process`
    },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['node:*'], message: 'packages/core must stay platform-neutral (§3).' },
          ],
          paths: [
            'fs',
            'path',
            'crypto',
            'os',
            'http',
            'https',
            'child_process',
            'net',
            'stream',
            'buffer',
            'url',
            'util',
            'zlib',
          ].map((name) => ({ name, message: 'packages/core must stay platform-neutral (§3).' })),
        },
      ],
    },
  },

  // Browser code: dashboard.
  {
    files: ['apps/dashboard/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },

  // React Native code: mobile.
  {
    files: ['apps/mobile/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // `process.env.EXPO_PUBLIC_*` is how Expo hands config to the bundle —
      // Babel inlines it at build time and React Native shims the rest (§7).
      globals: { ...globals.browser, __DEV__: 'readonly', process: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },

  prettier,
];
