ALTER TABLE lifecycle_state DROP COLUMN instance_epoch;
ALTER TABLE resource_owners DROP COLUMN instance_epoch;

DROP TABLE lifecycle_outbox;
CREATE TABLE lifecycle_outbox (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  intent_version INTEGER NOT NULL CHECK (intent_version > 0),
  report_sequence INTEGER NOT NULL CHECK (report_sequence > 0),
  payload TEXT NOT NULL,
  hash TEXT NOT NULL,
  upload_state TEXT NOT NULL CHECK (upload_state IN ('pending', 'unknown', 'confirmed', 'covered', 'failed')),
  receipt_json TEXT,
  UNIQUE (instance_id, report_sequence)
) STRICT;
