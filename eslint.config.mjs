import common from '@js-toolkit/eslint-config/common';
import { getFilesGlob, getTSExtensions } from '@js-toolkit/config-utils/extensions';
import { defineConfig, globalIgnores } from 'eslint/config';

const eslintConfig = defineConfig([
  ...common,
  globalIgnores(['node_modules/**', 'dist/**', 'fixtures/**', 'vitest.config.ts']),
  {
    files: [getFilesGlob(getTSExtensions())],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
]);

export default eslintConfig;
