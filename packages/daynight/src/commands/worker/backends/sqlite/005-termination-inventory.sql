CREATE TABLE termination_launches (
  identity TEXT NOT NULL,
  generation TEXT NOT NULL,
  execution_id TEXT NOT NULL,
  launch_id TEXT NOT NULL,
  controller_id TEXT NOT NULL,
  controller_instance_id TEXT NOT NULL,
  session_id TEXT,
  submission TEXT NOT NULL CHECK(submission IN ('not-submitted', 'unknown', 'acknowledged')),
  stop_proof TEXT CHECK(stop_proof IS NULL OR json_valid(stop_proof)),
  PRIMARY KEY(identity, generation),
  UNIQUE(identity, launch_id)
) STRICT;

CREATE TABLE termination_closures (
  identity TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL CHECK(json_valid(value))
) STRICT;

CREATE TABLE termination_domains (
  identity TEXT PRIMARY KEY NOT NULL,
  domain_id TEXT NOT NULL
) STRICT;

CREATE TABLE termination_owners (
  identity TEXT PRIMARY KEY NOT NULL,
  server_origin TEXT NOT NULL,
  owner_user_id TEXT,
  worker_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  worktree_id TEXT NOT NULL,
  provider TEXT,
  status TEXT NOT NULL,
  cleanup TEXT,
  session_id TEXT,
  execution_id TEXT,
  controller_id TEXT,
  generation TEXT
) STRICT;
