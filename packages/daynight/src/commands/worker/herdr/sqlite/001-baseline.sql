CREATE TABLE executions (
  identity TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  data TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
