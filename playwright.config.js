const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
