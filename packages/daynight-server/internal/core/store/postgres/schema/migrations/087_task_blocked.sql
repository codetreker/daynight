-- Validate every existing alias before renaming any row. A malformed JSON value
-- or a conflicting primary key aborts this migration and its ledger entry.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM task_properties
               WHERE CASE WHEN name IN ('paused', 'blocked')
                          THEN jsonb_typeof(value::jsonb) IS DISTINCT FROM 'boolean'
                          ELSE false END) THEN
        RAISE EXCEPTION 'task paused or blocked property must be a JSON boolean';
    END IF;
END $$;

UPDATE task_properties SET name = 'blocked' WHERE name = 'paused';
