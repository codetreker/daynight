ALTER TABLE execution ADD COLUMN history_content_policy TEXT NOT NULL DEFAULT 'legacy'
  CHECK(history_content_policy IN ('legacy', 'task_body'));

CREATE TABLE online_entries (
  id TEXT PRIMARY KEY,
  entry_seq INTEGER NOT NULL UNIQUE CHECK(entry_seq > 0),
  revision INTEGER NOT NULL CHECK(revision > 0),
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length > 0)
);

CREATE TABLE online_totals (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  entry_count INTEGER NOT NULL CHECK(entry_count >= 0),
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0)
);

INSERT INTO online_totals(id, entry_count, byte_length) VALUES(1, 0, 0);
