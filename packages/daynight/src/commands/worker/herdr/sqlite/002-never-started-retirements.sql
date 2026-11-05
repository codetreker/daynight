-- Retain the exact original registration without inventing a native stop or archive receipt.
CREATE TABLE never_started_retirements (
  identity TEXT PRIMARY KEY NOT NULL REFERENCES executions(identity),
  version INTEGER NOT NULL CHECK (version > 0),
  data TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
