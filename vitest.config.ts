import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [tsconfigPaths({ projects: ['tsconfig.base.json'] })],
  test: {
    environment: 'node',
    globals: false,
    include: ['custom-plugins/dsh-llm-failover/tests/**/*.spec.ts'],
  },
})
