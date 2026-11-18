-- Calendar replies (R19). Additive only: one new table.
-- One row per booking and attendee: the latest iTIP REPLY (partstat) and/or COUNTER (proposed time) received.
CREATE TABLE booking_rsvps (id INTEGER PRIMARY KEY, booking_uid TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL, partstat TEXT NOT NULL DEFAULT '', sequence INTEGER NOT NULL DEFAULT 0, dtstamp TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '', counter_start TEXT, counter_end TEXT, counter_at TEXT,
  host_prompt INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, UNIQUE (booking_uid, email));
