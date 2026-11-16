-- Optional integrations (R15-R18). Additive only: new columns with defaults and new tables.
ALTER TABLE event_types ADD COLUMN reminder_offsets TEXT NOT NULL DEFAULT '[1440,60]';
ALTER TABLE bookings ADD COLUMN ics_sequence INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bookings ADD COLUMN ics_uid TEXT;
ALTER TABLE bookings ADD COLUMN google_event_id TEXT;
CREATE TABLE email_log (id INTEGER PRIMARY KEY, booking_uid TEXT NOT NULL, kind TEXT NOT NULL, offset_min INTEGER NOT NULL DEFAULT 0,
  recipient TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, sent_at TEXT, UNIQUE (booking_uid, kind, offset_min, recipient));
CREATE INDEX email_log_status ON email_log(status);
CREATE TABLE calendar_feeds (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  url_enc TEXT NOT NULL, url_hint TEXT NOT NULL, etag TEXT, last_modified TEXT, last_sync_at TEXT, last_ok_at TEXT,
  last_error TEXT NOT NULL DEFAULT '', fail_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE busy_blocks (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL);
CREATE INDEX busy_user_start ON busy_blocks(user_id, start_ms);
CREATE TABLE google_accounts (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL, connected_at TEXT NOT NULL, last_error TEXT NOT NULL DEFAULT '');
CREATE TABLE oauth_states (state TEXT PRIMARY KEY, user_id INTEGER NOT NULL, verifier TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE cron_runs (name TEXT PRIMARY KEY, started_at INTEGER NOT NULL);
-- Test-only outbox (EMAIL_PROVIDER=test with TEST_CLOCK=1); stays empty in production.
CREATE TABLE test_outbox (id INTEGER PRIMARY KEY, recipient TEXT NOT NULL, reply_to TEXT NOT NULL, subject TEXT NOT NULL,
  text TEXT NOT NULL, html TEXT NOT NULL, ics TEXT NOT NULL, created_at TEXT NOT NULL);
