// The enterprise pilot checkout omits the upstream Vitest setup files.
// Keep this focused renderer regression runnable without changing upstream config.
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../packages/desktop/src'),
      '@renderer': path.resolve(__dirname, '../packages/desktop/src/renderer'),
    },
  },
  test: {
    environment: 'jsdom',
    include: [
      'tests/unit/finder-folder-drop.dom.test.tsx',
      'tests/unit/workspace-file-link.dom.test.tsx',
      'tests/unit/tool-step-localization.dom.test.tsx',
      'tests/unit/enterprise-web-conversations.dom.test.tsx',
      'tests/unit/enterprise-sidebar-source.dom.test.tsx',
      'tests/unit/enterprise-search-source.dom.test.tsx',
      'tests/unit/enterprise-idle-websocket.dom.test.ts',
    ],
  },
});
