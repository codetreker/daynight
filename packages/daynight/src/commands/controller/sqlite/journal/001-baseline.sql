CREATE TABLE execution (
  id INTEGER PRIMARY KEY CHECK(id=1),
  ticket_hash TEXT NOT NULL,
  owner_pid INTEGER,
  snapshot TEXT NOT NULL,
  last_sequence INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE outbox (
  sequence INTEGER PRIMARY KEY,
  value TEXT NOT NULL
);
