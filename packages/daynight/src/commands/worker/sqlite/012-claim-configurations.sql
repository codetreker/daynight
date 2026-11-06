CREATE TABLE claim_native_configurations (
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL,
  configuration TEXT NOT NULL,
  PRIMARY KEY(project_id, task_id, claim_id)
) STRICT;
