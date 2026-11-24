-- Old Worker writers must reject this format before accessing the authority.
CREATE TABLE lifecycle_adoption (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  server_origin TEXT NOT NULL,
  user_id TEXT NOT NULL,
  worker_id TEXT NOT NULL
) STRICT;
