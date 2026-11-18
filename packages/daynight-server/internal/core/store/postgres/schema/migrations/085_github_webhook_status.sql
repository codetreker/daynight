UPDATE project_github
SET last_webhook_received_at = NULL,
    last_webhook_attempt_at = NULL,
    last_webhook_success_at = NULL,
    webhook_error_code = NULL,
    webhook_error_message = NULL,
    webhook_error_at = NULL,
    revision = revision + 1,
    updated_at = statement_timestamp()
WHERE last_webhook_received_at IS NOT NULL
   OR last_webhook_attempt_at IS NOT NULL
   OR last_webhook_success_at IS NOT NULL
   OR webhook_error_code IS NOT NULL
   OR webhook_error_message IS NOT NULL
   OR webhook_error_at IS NOT NULL;
