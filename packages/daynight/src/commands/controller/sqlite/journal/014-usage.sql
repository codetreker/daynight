CREATE TABLE usage_sources (
  source_key TEXT PRIMARY KEY,
  canonical_hash TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  originating_state_id TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE usage_outbox (
  event_id TEXT PRIMARY KEY,
  local_sequence INTEGER NOT NULL UNIQUE,
  state_id TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE usage_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO usage_meta(key,value) VALUES ('last_sequence','"0"'),('collection_gap','null');
