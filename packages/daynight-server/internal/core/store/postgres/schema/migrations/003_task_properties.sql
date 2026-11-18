ALTER TABLE tasks ADD COLUMN properties text NOT NULL
    DEFAULT '{"pullRequests":[]}';
