-- Events captured before this migration keep NULL actors, meaning unknown.
ALTER TABLE webhook_events
    ADD COLUMN actor_kind text,
    ADD COLUMN actor_user_id uuid,
    ADD COLUMN actor_bot_id uuid;
