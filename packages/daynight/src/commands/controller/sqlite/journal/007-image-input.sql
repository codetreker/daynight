CREATE TABLE input_intents (
  operation_id TEXT PRIMARY KEY,
  canonical TEXT NOT NULL,
  sha256 TEXT NOT NULL
);

CREATE TABLE input_observations (
  operation_id TEXT PRIMARY KEY,
  observation TEXT NOT NULL
);

CREATE TABLE image_occurrences (
  image_id TEXT PRIMARY KEY,
  occurrence TEXT NOT NULL,
  native_source TEXT,
  source_sequence TEXT NOT NULL,
  acknowledged INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE image_preparations (
  upload_id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE image_chunks (
  upload_id TEXT NOT NULL,
  offset TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (upload_id, offset)
);

CREATE TABLE image_pins (
  pin_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  native_session_id TEXT,
  kind TEXT NOT NULL,
  private_path TEXT NOT NULL,
  released INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE image_runtime_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE image_captures (
  capture_id TEXT PRIMARY KEY,
  image_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  validated TEXT NOT NULL
);
