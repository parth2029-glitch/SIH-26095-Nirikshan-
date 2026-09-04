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
      globals: { ...globals.browser, __DEV__: 'readonly' },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },

  prettier,
];
