ALTER TABLE execution ADD COLUMN archive_incomplete INTEGER NOT NULL DEFAULT 0;
UPDATE execution SET archive_incomplete=1 WHERE projection_gap IS NOT NULL;

CREATE TABLE content_index (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  revision TEXT NOT NULL,
  entry_seq TEXT NOT NULL
);

DROP TABLE projection;
DROP TABLE resources;
