/** Bindings for this Worker. Run `npm run types` if you want a generated `worker-configuration.d.ts`. */
interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  NOW: string;
  TEST_CLOCK: string;
  ALLOW_SIGNUP: string;
  /** Comma-separated allowlist for sign-up, sign-in and sessions. Empty or unset means no extra restriction. */
  ALLOWED_EMAILS: string;
  EMAIL_PROVIDER: string;
  EMAIL_FROM: string;
  SITE_URL: string;
  ICAL_POLL_MINUTES: string;
  /** Worker secret. Set with `wrangler secret put ENCRYPTION_KEY`. Never commit a value. */
  ENCRYPTION_KEY?: string;
  /** Worker secret. Set with `wrangler secret put RESEND_API_KEY`. Never commit a value. */
  RESEND_API_KEY?: string;
  /** Optional Cloudflare Email Sending binding (wrangler `send_email`). */
  EMAIL?: SendEmail;
}
