import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests',
  testMatch: 'extension.spec.ts',
  reporter: 'list',
  use: { browserName: 'chromium' },
  workers: 1,
})
