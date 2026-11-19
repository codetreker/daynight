ALTER TABLE assistant_task_items ADD COLUMN opened_at timestamptz;
ALTER TABLE assistant_task_items ADD COLUMN closed_at timestamptz;
CREATE TABLE assistant_task_item_closures (
    id uuid PRIMARY KEY,
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    item_id uuid NOT NULL,
    episode bigint NOT NULL,
    opened_at timestamptz,
    closed_at timestamptz NOT NULL
);
