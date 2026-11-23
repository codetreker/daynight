CREATE TABLE worker_lifecycle_bindings (
  execution_generation TEXT PRIMARY KEY,
  ticket_hash TEXT NOT NULL,
  binding_json TEXT NOT NULL
);
