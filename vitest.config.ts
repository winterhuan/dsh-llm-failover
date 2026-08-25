import { createRequire } from 'node:module'
import { defineConfig } from 'vitest/config'

// One React instance: this package's own, shared with the react-dom the specs
// render through. Externalized CJS deps resolve their internal
// `require('react')` past Vite's alias table.
const localRequire = createRequire(import.meta.url)

export default defineConfig({
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
    include: ['tests/**/*.spec.ts'],
    // Inline the primitives package so Vite transforms its `.module.css`
    // imports; externalized ESM would hand them to the native loader.
    server: { deps: { inline: ['@deepseek-ai/dsh-client-ui-primitives'] } },
  },
})
