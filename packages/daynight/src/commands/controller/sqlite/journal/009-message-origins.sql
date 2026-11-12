CREATE TABLE input_message_origins (
  entry_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL UNIQUE,
  origin TEXT NOT NULL
);
