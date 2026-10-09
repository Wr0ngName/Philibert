// `.mjs`, not `.js`: this file uses ESM syntax and package.json has no
// "type": "module", so Node printed MODULE_TYPELESS_PACKAGE_JSON on every
// lint run — "not specified and it doesn't parse as CommonJS ... Reparsing as
// ES module". The extension states the module type locally. Do NOT instead
// add "type": "module" to package.json as that warning suggests: that would
// switch module resolution for the Electron main entry and forge.config.ts
// too, which is a far larger change than silencing a lint warning.

import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import vuePlugin from 'eslint-plugin-vue';
import importPlugin from 'eslint-plugin-import-x';
import globals from 'globals';

export default [
  // Global ignores
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      '.vite/**',
      '*.config.js',
      '*.config.mjs',
      '*.config.ts',
    ],
  },

  // Base JS/TS configuration
  {
    files: ['**/*.{js,mjs,cjs,ts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      'import-x': importPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc' },
        },
      ],
      'no-undef': 'off',
    },
    settings: {
      'import-x/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
      },
    },
  },

  // Test files configuration - relax rules for test mocks
  {
    files: ['**/__tests__/**/*.ts', '**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Vue files — flat/recommended provides parser, processor, and all rules
  ...vuePlugin.configs['flat/recommended'],

  // Vue files — add TypeScript integration and overrides
  {
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tsParser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
      globals: {
        ...globals.browser,
        ...globals.es2022,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      'vue/multi-word-component-names': 'off',
      'vue/no-v-html': 'warn',
      'no-undef': 'off',
    },
  },

  // Files with intentional v-html.
  //
  // The rule stays on everywhere else, so adding a file here is a deliberate
  // claim about it. The only thing that justifies the claim: the bound value
  // comes from renderMarkdown or renderUserMarkdown in utils/markdown, which
  // run DOMPurify.sanitize with an explicit tag and attribute allowlist.
  // v-html bound to anything else — a raw IPC payload, a file's contents, a
  // tool result — does not belong here and should be rendered as text.
  {
    files: [
      'src/renderer/components/chat/MessageItem.vue',
      'src/renderer/components/files/MarkdownViewerModal.vue',
    ],
    rules: {
      'vue/no-v-html': 'off',
    },
  },
];
