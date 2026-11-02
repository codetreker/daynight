ALTER TABLE execution ADD COLUMN last_acknowledged INTEGER NOT NULL DEFAULT 0;

CREATE TABLE projection (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  revision INTEGER NOT NULL,
  value TEXT NOT NULL
);
