import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

const workspaceRequire = createRequire(new URL('../../packages/client/ui-settings/package.json', import.meta.url))

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [tsconfigPaths({ projects: ['tsconfig.base.json'] })],
  resolve: {
    alias: [
      { find: 'react/jsx-dev-runtime', replacement: workspaceRequire.resolve('react/jsx-dev-runtime') },
      { find: 'react/jsx-runtime', replacement: workspaceRequire.resolve('react/jsx-runtime') },
      { find: 'react', replacement: workspaceRequire.resolve('react') },
    ],
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['custom-plugins/dsh-llm-failover/tests/**/*.spec.ts'],
  },
})
