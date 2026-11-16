-- Test-only outbox keeps the full MIME message too (additive).
ALTER TABLE test_outbox ADD COLUMN mime TEXT NOT NULL DEFAULT '';
