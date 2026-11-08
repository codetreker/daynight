ALTER TABLE workers
 ADD COLUMN configuration_revision bigint,
 ADD COLUMN configuration_updated_at timestamptz,
 ADD COLUMN desired_configuration jsonb,
 ADD COLUMN configuration_observation_revision bigint NOT NULL DEFAULT 0,
 ADD COLUMN configuration_observation jsonb,
 ADD CONSTRAINT worker_configuration_revision_positive CHECK (configuration_revision > 0),
 ADD CONSTRAINT worker_configuration_observation_revision_nonnegative CHECK (configuration_observation_revision >= 0),
 ADD CONSTRAINT worker_configuration_complete CHECK (
  (configuration_revision IS NULL AND configuration_updated_at IS NULL AND desired_configuration IS NULL) OR
  (configuration_revision IS NOT NULL AND configuration_updated_at IS NOT NULL AND desired_configuration IS NOT NULL AND jsonb_typeof(desired_configuration) = 'object')),
 ADD CONSTRAINT worker_configuration_observation_object CHECK (configuration_observation IS NULL OR jsonb_typeof(configuration_observation) = 'object');
