import { defineConfig } from "@playwright/test";
import path from "node:path";

process.env.HOST ??= "127.0.0.1";
process.env.PORT ??= "4173";
process.env.DATABASE_PATH ??= path.resolve("data", `e2e-${process.pid}.sqlite`);
process.env.PUBLIC_BASE_URL ??= "http://127.0.0.1:4173";
process.env.NODE_ENV ??= "production";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  outputDir: "test-results",
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    browserName: "chromium",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "iPhone 14 Pro Max layout",
      use: {
        viewport: { width: 430, height: 932 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: "Galaxy S24 Plus layout",
      use: {
        viewport: { width: 480, height: 1040 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: "npm start",
    url: "http://127.0.0.1:4173/api/health",
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
