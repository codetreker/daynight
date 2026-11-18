LOCK TABLE tasks IN ACCESS EXCLUSIVE MODE;

CREATE TABLE task_properties (
    task_id uuid NOT NULL,
    name text COLLATE "C" NOT NULL CHECK (name <> ''),
    value text NOT NULL,
    PRIMARY KEY (task_id, name)
);
