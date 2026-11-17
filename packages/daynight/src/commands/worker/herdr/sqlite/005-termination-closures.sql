CREATE TABLE termination_inventory (
  identity TEXT PRIMARY KEY NOT NULL REFERENCES executions(identity),
  version INTEGER NOT NULL CHECK (version > 0),
  data TEXT NOT NULL CHECK (json_valid(data)),
  digest TEXT NOT NULL
) STRICT;
CREATE TABLE termination_bindings (
  identity TEXT PRIMARY KEY NOT NULL REFERENCES executions(identity),
  domain_id TEXT NOT NULL
) STRICT;
CREATE TABLE termination_closures (
  identity TEXT PRIMARY KEY NOT NULL REFERENCES executions(identity),
  data TEXT NOT NULL CHECK (json_valid(data))
) STRICT;
