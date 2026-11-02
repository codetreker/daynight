CREATE TABLE executions (
  identity TEXT PRIMARY KEY NOT NULL,
  data TEXT NOT NULL CHECK(json_valid(data))
) STRICT;
