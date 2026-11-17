import { defineConfig } from 'vitest/config'

// Post-build checks against dist/. Deliberately separate from vite.config.ts,
// which excludes this file from the unit-test run.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/build.test.ts'],
  },
})
