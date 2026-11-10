ALTER TABLE content_index ADD COLUMN content_file TEXT NOT NULL DEFAULT '';
ALTER TABLE content_index ADD COLUMN content_sha256 TEXT NOT NULL DEFAULT '';
ALTER TABLE content_index ADD COLUMN content_bytes INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX content_index_sequence ON content_index(entry_seq);

CREATE TABLE native_input_publications (
  operation_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  native_message_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  value TEXT NOT NULL,
  UNIQUE(provider, native_session_id, native_message_id)
);

CREATE TABLE native_input_publication_images (
  operation_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  part_index INTEGER NOT NULL,
  PRIMARY KEY(operation_id, image_id),
  UNIQUE(image_id)
);
