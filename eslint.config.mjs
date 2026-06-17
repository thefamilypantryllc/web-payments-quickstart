// eslint.config.mjs
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      'node_modules/**',
      '_del_node_modules/**',
      'coverage/**',
      '.nyc_output/**',
    ],
  },

  js.configs.recommended,

  {
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
  },

  {
    files: ['eslint.config.mjs'],
    languageOptions: {
      sourceType: 'module',
    },
  },
];