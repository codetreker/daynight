ALTER TABLE execution ADD COLUMN source_floor INTEGER NOT NULL DEFAULT 0;

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  descriptor TEXT NOT NULL,
  content BLOB
);
