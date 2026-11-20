CREATE INDEX assistant_task_item_closures_task_closed
    ON assistant_task_item_closures (task_id, closed_at);
