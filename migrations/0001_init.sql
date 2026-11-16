CREATE TABLE users (
  id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE, bio TEXT NOT NULL DEFAULT '', time_zone TEXT NOT NULL,
  time_format INTEGER NOT NULL DEFAULT 12, week_start TEXT NOT NULL DEFAULT 'monday', created_at TEXT NOT NULL);
CREATE TABLE sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE schedules (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, time_zone TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX s_one_default ON schedules(user_id) WHERE is_default=1;
CREATE TABLE schedule_hours (id INTEGER PRIMARY KEY, schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL, start_min INTEGER NOT NULL, end_min INTEGER NOT NULL);
CREATE TABLE date_overrides (id INTEGER PRIMARY KEY, schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  date TEXT NOT NULL, start_min INTEGER, end_min INTEGER);
CREATE TABLE event_types (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL, slug TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', duration_min INTEGER NOT NULL,
  position INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, location_kind TEXT NOT NULL DEFAULT 'video',
  location_value TEXT NOT NULL DEFAULT '', schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
  min_notice_min INTEGER NOT NULL DEFAULT 120, buffer_before_min INTEGER NOT NULL DEFAULT 0, buffer_after_min INTEGER NOT NULL DEFAULT 0,
  slot_step_min INTEGER, max_per_day INTEGER, future_days INTEGER, requires_approval INTEGER NOT NULL DEFAULT 0,
  hide_guests INTEGER NOT NULL DEFAULT 0, color TEXT NOT NULL DEFAULT '#111827', created_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX et_user_slug ON event_types(user_id, slug);
CREATE TABLE bookings (id INTEGER PRIMARY KEY, uid TEXT NOT NULL UNIQUE, event_type_id INTEGER NOT NULL REFERENCES event_types(id),
  host_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL,
  start_utc TEXT NOT NULL, end_utc TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
  buffer_before_min INTEGER NOT NULL DEFAULT 0, buffer_after_min INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL, booker_name TEXT NOT NULL, booker_email TEXT NOT NULL, booker_phone TEXT NOT NULL DEFAULT '',
  booker_tz TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '', guests TEXT NOT NULL DEFAULT '[]', location TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT NOT NULL DEFAULT '', cancelled_by TEXT, rescheduled INTEGER NOT NULL DEFAULT 0, from_uid TEXT,
  reschedule_reason TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX b_host_start ON bookings(host_id, start_ms);
