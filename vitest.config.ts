import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// One React instance: this package's own, shared with the react-dom the specs
// render through. Aliasing react-dom is not enough — externalized CJS deps
// resolve their internal `require('react')` past Vite's alias table.
const localRequire = createRequire(import.meta.url)

export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  plugins: [tsconfigPaths({ projects: ['tsconfig.base.json'] })],
  resolve: {
    alias: [
      { find: 'react/jsx-dev-runtime', replacement: localRequire.resolve('react/jsx-dev-runtime') },
      { find: 'react/jsx-runtime', replacement: localRequire.resolve('react/jsx-runtime') },
      { find: 'react', replacement: localRequire.resolve('react') },
    ],
  },
  test: {
    environment: 'node',
    globals: false,
    include: ['custom-plugins/dsh-llm-failover/tests/**/*.spec.ts'],
  },
})
