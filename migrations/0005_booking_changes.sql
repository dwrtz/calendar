-- Proposed new times (R19 COUNTER). Additive only: one new table and its indexes.
-- One row per proposal. status: pending, accepted, declined, expired, superseded, rejected (not available), cancelled.
-- While a row is pending, the proposed time is held by a busy_blocks row with source 'hold:{booking uid}'.
CREATE TABLE booking_changes (id INTEGER PRIMARY KEY, booking_uid TEXT NOT NULL,
  proposer_email TEXT NOT NULL, proposer_name TEXT NOT NULL DEFAULT '', proposer_role TEXT NOT NULL,
  counterpart_email TEXT NOT NULL DEFAULT '', counterpart_name TEXT NOT NULL DEFAULT '', counterpart_role TEXT NOT NULL DEFAULT '',
  start_utc TEXT, end_utc TEXT, from_start_utc TEXT NOT NULL, from_end_utc TEXT NOT NULL,
  sequence INTEGER NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', comment TEXT NOT NULL DEFAULT '',
  expires_at TEXT, created_at TEXT NOT NULL, resolved_at TEXT);
CREATE INDEX booking_changes_uid ON booking_changes(booking_uid, status);
CREATE UNIQUE INDEX booking_changes_one_pending ON booking_changes(booking_uid) WHERE status = 'pending';
