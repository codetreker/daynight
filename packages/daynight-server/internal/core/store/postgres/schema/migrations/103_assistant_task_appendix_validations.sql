ALTER TABLE assistant_task_appendix
    ADD COLUMN scope_project_ids jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN scope_event_types jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN scope_item_categories jsonb NOT NULL DEFAULT '[]',
    ADD COLUMN success_count bigint NOT NULL DEFAULT 0,
    ADD COLUMN failure_count bigint NOT NULL DEFAULT 0,
    ADD COLUMN last_validated_at timestamptz;

CREATE TABLE assistant_task_appendix_validations (
    owner_user_id uuid NOT NULL,
    task_id uuid NOT NULL,
    appendix_id uuid NOT NULL,
    outcome_record_id uuid NOT NULL,
    outcome text NOT NULL,
    validator_bot_id uuid NOT NULL,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (appendix_id, outcome_record_id)
);
CREATE INDEX assistant_task_appendix_validations_task ON assistant_task_appendix_validations (task_id);
