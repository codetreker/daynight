UPDATE tasks
SET properties = regexp_replace(properties, '}([[:space:]]*)$', ',"worker":null}\1');

ALTER TABLE tasks ALTER COLUMN properties SET DEFAULT '{"pullRequests":[],"worker":null}';
