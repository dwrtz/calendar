import { defineConfig } from "@playwright/test";
const PORT = 3210, IPORT = 3221;
// Runs the real Worker under `wrangler dev` with a fresh local D1 and a frozen clock.
// "core" has every integration off (the default); "integrations" turns on the test email outbox and an encryption key.
const serve = (port: number, dir: string, vars: string[] = [], build = true) => [
  `rm -rf ${dir}`,
  // Only the first server builds; the second waits for that build so they don't write dist/ at once.
  build ? "rm -f .e2e-built && npm run build && touch .e2e-built" : "sleep 2 && until [ -f .e2e-built ]; do sleep 1; done",
  `npx wrangler d1 migrations apply DB --local --persist-to ${dir}`,
  `npx wrangler dev --port ${port} --ip 127.0.0.1 --persist-to ${dir} --var NOW:2026-11-15T12:00:00.000Z --var TEST_CLOCK:1 ${vars.map((v) => `--var ${v}`).join(" ")} --show-interactive-dev-session=false`,
].join(" && ");
// Test-only key (not a real secret): 32 bytes of 0x01, base64.
const TEST_KEY = Buffer.alloc(32, 1).toString("base64");
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  timeout: 60_000,
  use: { viewport: { width: 1280, height: 900 }, timezoneId: "America/New_York" },
  projects: [
    { name: "core", testIgnore: /6-integrations/, use: { baseURL: `http://127.0.0.1:${PORT}` } },
    { name: "integrations", testMatch: /6-integrations/, use: { baseURL: `http://127.0.0.1:${IPORT}` } },
  ],
  webServer: [
    { command: serve(PORT, ".e2e"), url: `http://127.0.0.1:${PORT}/api/now`, reuseExistingServer: false, timeout: 180_000 },
    { command: serve(IPORT, ".e2e-int", ["EMAIL_PROVIDER:test", `ENCRYPTION_KEY:${TEST_KEY}`, `SITE_URL:http://127.0.0.1:${IPORT}`, "ICAL_POLL_MINUTES:5"], false), url: `http://127.0.0.1:${IPORT}/api/now`, reuseExistingServer: false, timeout: 180_000 },
  ],
});
