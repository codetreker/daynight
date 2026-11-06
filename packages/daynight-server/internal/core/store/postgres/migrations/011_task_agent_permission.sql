ALTER TABLE tasks ADD COLUMN allow_agents boolean NOT NULL DEFAULT true;
ALTER TABLE tasks ALTER COLUMN allow_agents SET DEFAULT false;
