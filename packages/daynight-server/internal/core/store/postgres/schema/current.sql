-- Schema snapshot version: 73

CREATE FUNCTION "webhook_policy_no_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    RAISE EXCEPTION 'webhook policies are immutable';
END
$$;

CREATE TABLE "assistant_task_appendix" (
    "id" "uuid" NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "request_fingerprint" "text" NOT NULL,
    "text" "text" NOT NULL,
    "source_records" "jsonb" NOT NULL,
    "author_bot_id" "uuid",
    "state" "text" NOT NULL,
    "version" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE "assistant_task_claim_operations" (
    "owner_user_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "operation_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "actor_bot_id" "uuid",
    "request_fingerprint" "text" NOT NULL,
    "admitted_at" timestamp with time zone NOT NULL,
    "resulting_version" bigint NOT NULL,
    "resulting_generation" bigint NOT NULL,
    "holder_bot_id" "uuid",
    "credential_operation_id" "uuid",
    "lease_until" timestamp with time zone
);

CREATE TABLE "assistant_task_events" (
    "id" "uuid" NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "request_fingerprint" "text" NOT NULL,
    "target_bot_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "state" "text" NOT NULL,
    "attention" boolean NOT NULL,
    "delivered_at" timestamp with time zone,
    "seen_at" timestamp with time zone,
    "ack_operation_id" "uuid",
    "ack_fingerprint" "text",
    "created_at" timestamp with time zone NOT NULL
);

CREATE TABLE "assistant_task_inquiries" (
    "id" "uuid" NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "request_fingerprint" "text" NOT NULL,
    "item_id" "uuid",
    "from_bot_id" "uuid" NOT NULL,
    "to_bot_id" "uuid" NOT NULL,
    "answer_bot_id" "uuid",
    "question" "text" NOT NULL,
    "answer" "text" NOT NULL,
    "state" "text" NOT NULL,
    "deadline" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "answered_at" timestamp with time zone
);

CREATE TABLE "assistant_task_items" (
    "id" "uuid" NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "request_fingerprint" "text" NOT NULL,
    "key" "text" NOT NULL,
    "episode" bigint NOT NULL,
    "state" "text" NOT NULL,
    "category" "text" NOT NULL,
    "follower_bot_id" "uuid",
    "app_state" "jsonb" NOT NULL,
    "version" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE "assistant_task_manual_versions" (
    "owner_user_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "version" bigint NOT NULL,
    "body" "text" NOT NULL,
    "rules" "jsonb" NOT NULL,
    "source" "text" NOT NULL,
    "proposal_id" "uuid",
    "created_at" timestamp with time zone NOT NULL
);

CREATE TABLE "assistant_task_proposals" (
    "id" "uuid" NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "request_fingerprint" "text" NOT NULL,
    "base_version" bigint NOT NULL,
    "body" "text" NOT NULL,
    "rules" "jsonb" NOT NULL,
    "reason" "text" NOT NULL,
    "evidence_records" "jsonb" NOT NULL,
    "author_bot_id" "uuid",
    "widens" boolean NOT NULL,
    "status" "text" NOT NULL,
    "decision_note" "text" NOT NULL,
    "decided_at" timestamp with time zone,
    "created_at" timestamp with time zone NOT NULL
);

CREATE TABLE "assistant_task_records" (
    "id" "uuid" NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "request_fingerprint" "text" NOT NULL,
    "item_id" "uuid",
    "author" "text" NOT NULL,
    "author_bot_id" "uuid",
    "kind" "text" NOT NULL,
    "text" "text" NOT NULL,
    "refs" "jsonb" NOT NULL,
    "created_at" timestamp with time zone NOT NULL
);

CREATE TABLE "assistant_tasks" (
    "id" "uuid" NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "request_fingerprint" "text" NOT NULL,
    "application" "text" NOT NULL,
    "name" "text" NOT NULL,
    "purpose" "text" NOT NULL,
    "scope" "text" NOT NULL,
    "kind" "text" NOT NULL,
    "state" "text" NOT NULL,
    "takeover" "text" NOT NULL,
    "trigger" "jsonb",
    "version" bigint NOT NULL,
    "manual_version" bigint NOT NULL,
    "claim_generation" bigint NOT NULL,
    "holder_bot_id" "uuid",
    "claim_token_hash" "text",
    "credential_operation_id" "uuid",
    "claimed_at" timestamp with time zone,
    "renewed_at" timestamp with time zone,
    "lease_until" timestamp with time zone,
    "record_last_created_at" timestamp with time zone,
    "record_last_id" "uuid",
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE "bot_configuration_preferences" (
    "user_id" "uuid" NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "cwd" "text",
    "cwd_creation_order" bigint,
    "provider" "text",
    "provider_creation_order" bigint,
    CONSTRAINT "bot_configuration_preferences_check" CHECK (((("cwd" IS NULL) AND ("cwd_creation_order" IS NULL)) OR (("cwd" IS NOT NULL) AND ("cwd_creation_order" IS NOT NULL) AND ("cwd_creation_order" > 0)))),
    CONSTRAINT "bot_configuration_preferences_check1" CHECK (((("provider" IS NULL) AND ("provider_creation_order" IS NULL)) OR (("provider" IS NOT NULL) AND ("provider_creation_order" IS NOT NULL) AND ("provider_creation_order" > 0)))),
    CONSTRAINT "bot_configuration_preferences_check2" CHECK ((("cwd" IS NOT NULL) OR ("provider" IS NOT NULL))),
    CONSTRAINT "bot_configuration_preferences_provider_check" CHECK (("provider" = ANY (ARRAY['codex'::"text", 'claude'::"text", 'copilot'::"text"])))
);

CREATE TABLE "bot_effort_preferences" (
    "user_id" "uuid" NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "model" "text" NOT NULL,
    "reasoning_effort" "text" NOT NULL,
    "creation_order" bigint NOT NULL,
    CONSTRAINT "bot_effort_preferences_creation_order_check" CHECK (("creation_order" > 0)),
    CONSTRAINT "bot_effort_preferences_model_check" CHECK ((("octet_length"("model") >= 1) AND ("octet_length"("model") <= 256))),
    CONSTRAINT "bot_effort_preferences_provider_check" CHECK (("provider" = ANY (ARRAY['codex'::"text", 'claude'::"text", 'copilot'::"text"]))),
    CONSTRAINT "bot_effort_preferences_reasoning_effort_check" CHECK ((("octet_length"("reasoning_effort") >= 1) AND ("octet_length"("reasoning_effort") <= 64)))
);

CREATE TABLE "bot_model_preferences" (
    "user_id" "uuid" NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "provider" "text" NOT NULL,
    "model" "text" NOT NULL,
    "creation_order" bigint NOT NULL,
    CONSTRAINT "bot_model_preferences_creation_order_check" CHECK (("creation_order" > 0)),
    CONSTRAINT "bot_model_preferences_model_check" CHECK ((("octet_length"("model") >= 1) AND ("octet_length"("model") <= 256))),
    CONSTRAINT "bot_model_preferences_provider_check" CHECK (("provider" = ANY (ARRAY['codex'::"text", 'claude'::"text", 'copilot'::"text"])))
);

CREATE TABLE "bot_worker_preferences" (
    "user_id" "uuid" NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "creation_order" bigint NOT NULL,
    CONSTRAINT "bot_worker_preferences_creation_order_check" CHECK (("creation_order" > 0))
);

CREATE TABLE "bots" (
    "id" "uuid" NOT NULL,
    "owner_user_id" "uuid" NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "version" bigint DEFAULT 1 NOT NULL,
    "creation_order" bigint NOT NULL,
    "request_fingerprint" "text" NOT NULL,
    "requested_overrides" "jsonb" NOT NULL,
    "resolved_configuration" "jsonb" NOT NULL,
    "role_configuration" "jsonb",
    "session_id" "uuid",
    "startup_result" "jsonb" NOT NULL,
    "deletion" "jsonb",
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    CONSTRAINT "bots_deletion_check" CHECK (("jsonb_typeof"("deletion") = 'object'::"text")),
    CONSTRAINT "bots_name_check" CHECK ((("char_length"("name") >= 1) AND ("char_length"("name") <= 40))),
    CONSTRAINT "bots_request_fingerprint_check" CHECK (("request_fingerprint" ~ '^[0-9a-f]{64}$'::"text")),
    CONSTRAINT "bots_requested_overrides_check" CHECK (("jsonb_typeof"("requested_overrides") = 'object'::"text")),
    CONSTRAINT "bots_resolved_configuration_check" CHECK (("jsonb_typeof"("resolved_configuration") = 'object'::"text")),
    CONSTRAINT "bots_role_configuration_check" CHECK (("jsonb_typeof"("role_configuration") = 'object'::"text")),
    CONSTRAINT "bots_startup_result_check" CHECK (("jsonb_typeof"("startup_result") = 'object'::"text")),
    CONSTRAINT "bots_version_check" CHECK (("version" > 0))
);

ALTER TABLE "bots" ALTER COLUMN "creation_order" ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME "bots_creation_order_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

CREATE TABLE "device_authorization_limits" (
    "bucket_hash" "bytea" NOT NULL,
    "attempts" integer NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    CONSTRAINT "device_authorization_limits_attempts_check" CHECK (("attempts" > 0)),
    CONSTRAINT "device_authorization_limits_bucket_hash_check" CHECK (("octet_length"("bucket_hash") = 32))
);

CREATE TABLE "device_authorizations" (
    "id" "uuid" NOT NULL,
    "device_code_hash" "bytea" NOT NULL,
    "user_code" "text" NOT NULL,
    "status" "text" NOT NULL,
    "user_id" "uuid",
    "created_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "next_poll_at" timestamp with time zone NOT NULL,
    "poll_interval_seconds" integer NOT NULL,
    CONSTRAINT "device_authorizations_check" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "device_authorizations_check1" CHECK ((("status" = 'pending'::"text") = ("user_id" IS NULL))),
    CONSTRAINT "device_authorizations_device_code_hash_check" CHECK (("octet_length"("device_code_hash") = 32)),
    CONSTRAINT "device_authorizations_poll_interval_seconds_check" CHECK (("poll_interval_seconds" >= 5)),
    CONSTRAINT "device_authorizations_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'denied'::"text", 'consumed'::"text"]))),
    CONSTRAINT "device_authorizations_user_code_check" CHECK (("user_code" ~ '^[BCDFGHJKLMNPQRSTVWXZ]{10}$'::"text"))
);

CREATE TABLE "login_transactions" (
    "id" "uuid" NOT NULL,
    "state_hash" "bytea" NOT NULL,
    "browser_binding_hash" "bytea" NOT NULL,
    "provider" "text" NOT NULL,
    "return_path" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "scope_hash" "bytea" NOT NULL,
    CONSTRAINT "login_transactions_browser_binding_hash_check" CHECK (("octet_length"("browser_binding_hash") = 32)),
    CONSTRAINT "login_transactions_provider_check" CHECK (("provider" = ANY (ARRAY['microsoft'::"text", 'google'::"text", 'github'::"text"]))),
    CONSTRAINT "login_transactions_return_path_check" CHECK (("left"("return_path", 1) = '/'::"text")),
    CONSTRAINT "login_transactions_scope_hash_check" CHECK (("octet_length"("scope_hash") = 32)),
    CONSTRAINT "login_transactions_state_hash_check" CHECK (("octet_length"("state_hash") = 32))
);

CREATE TABLE "oauth_access_tokens" (
    "id" "uuid" NOT NULL,
    "grant_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "token_hash" "bytea" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    CONSTRAINT "oauth_access_tokens_check" CHECK ((("expires_at" > "created_at") AND ("expires_at" <= ("created_at" + '01:00:00'::interval)))),
    CONSTRAINT "oauth_access_tokens_token_hash_check" CHECK (("octet_length"("token_hash") = 32))
);

CREATE TABLE "oauth_authorization_cleanup_cursor" (
    "singleton" boolean DEFAULT true NOT NULL,
    "next_kind" smallint NOT NULL,
    CONSTRAINT "oauth_authorization_cleanup_cursor_next_kind_check" CHECK ((("next_kind" >= 0) AND ("next_kind" <= 1))),
    CONSTRAINT "oauth_authorization_cleanup_cursor_singleton_check" CHECK ("singleton")
);

CREATE TABLE "oauth_authorizations" (
    "id" "uuid" NOT NULL,
    "binding_hash" "bytea" NOT NULL,
    "client_snapshot" "jsonb" NOT NULL,
    "client_id" "text" NOT NULL,
    "redirect_uri" "text" NOT NULL,
    "resource" "text" NOT NULL,
    "scope" "text" NOT NULL,
    "challenge" "text" NOT NULL,
    "state" "text" NOT NULL,
    "state_present" boolean NOT NULL,
    "status" "text" NOT NULL,
    "user_id" "uuid",
    "grant_id" "uuid",
    "code_hash" "bytea",
    "created_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "code_expires_at" timestamp with time zone,
    "retain_until" timestamp with time zone NOT NULL,
    CONSTRAINT "oauth_authorizations_binding_hash_check" CHECK (("octet_length"("binding_hash") = 32)),
    CONSTRAINT "oauth_authorizations_code_hash_check" CHECK ((("code_hash" IS NULL) OR ("octet_length"("code_hash") = 32))),
    CONSTRAINT "oauth_authorizations_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'denied'::"text", 'consumed'::"text", 'expired'::"text"])))
);

CREATE TABLE "oauth_clients" (
    "id" "text" NOT NULL,
    "metadata" "jsonb" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "last_used_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    CONSTRAINT "oauth_clients_check" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "oauth_clients_id_check" CHECK (("length"("id") > 0))
);

CREATE TABLE "oauth_credential_cleanup_cursor" (
    "singleton" boolean DEFAULT true NOT NULL,
    "next_kind" smallint NOT NULL,
    CONSTRAINT "oauth_credential_cleanup_cursor_next_kind_check" CHECK ((("next_kind" >= 0) AND ("next_kind" <= 2))),
    CONSTRAINT "oauth_credential_cleanup_cursor_singleton_check" CHECK ("singleton")
);

CREATE TABLE "oauth_grants" (
    "id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "client_id" "text" NOT NULL,
    "client_snapshot" "jsonb" NOT NULL,
    "resource" "text" NOT NULL,
    "scope" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "last_used_at" timestamp with time zone,
    CONSTRAINT "oauth_grants_client_id_check" CHECK (("length"("client_id") > 0)),
    CONSTRAINT "oauth_grants_lifetime_check" CHECK ((("expires_at" > "created_at") AND ((("scope" = 'daynight:api'::"text") AND ("client_id" = 'societas-bot'::"text")) OR ("expires_at" <= ("created_at" + '720:00:00'::interval))))),
    CONSTRAINT "oauth_grants_resource_check" CHECK (("length"("resource") > 0)),
    CONSTRAINT "oauth_grants_scope_check" CHECK (("length"("scope") > 0))
);

CREATE TABLE "oauth_refresh_tokens" (
    "token_hash" "bytea" NOT NULL,
    "grant_id" "uuid" NOT NULL,
    "client_id" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "consumed_at" timestamp with time zone,
    "replaced_by_hash" "bytea",
    CONSTRAINT "oauth_refresh_tokens_check" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "oauth_refresh_tokens_replaced_by_hash_check" CHECK ((("replaced_by_hash" IS NULL) OR ("octet_length"("replaced_by_hash") = 32))),
    CONSTRAINT "oauth_refresh_tokens_token_hash_check" CHECK (("octet_length"("token_hash") = 32))
);

CREATE TABLE "personal_access_tokens" (
    "id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "token_hash" "bytea" NOT NULL,
    "name" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone,
    "last_used_at" timestamp with time zone,
    CONSTRAINT "personal_access_tokens_check" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "personal_access_tokens_name_check" CHECK (((("char_length"("name") >= 1) AND ("char_length"("name") <= 100)) AND ("length"("btrim"("name")) > 0))),
    CONSTRAINT "personal_access_tokens_token_hash_check" CHECK (("octet_length"("token_hash") = 32))
);

CREATE TABLE "private_transfer_ledger" (
    "singleton" boolean DEFAULT true NOT NULL,
    "reserved_bytes" bigint DEFAULT 0 NOT NULL,
    "outstanding_bytes" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "private_transfer_ledger_check" CHECK ((("outstanding_bytes" >= 0) AND ("outstanding_bytes" <= "reserved_bytes"))),
    CONSTRAINT "private_transfer_ledger_reserved_bytes_check" CHECK (("reserved_bytes" >= 0)),
    CONSTRAINT "private_transfer_ledger_singleton_check" CHECK ("singleton")
);

CREATE TABLE "private_transfers" (
    "id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "authority_kind" "text" NOT NULL,
    "authority_id" "uuid" NOT NULL,
    "direction" "text" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "path" "text" NOT NULL,
    "content_type" "text" NOT NULL,
    "binding" "jsonb" NOT NULL,
    "data" "jsonb" NOT NULL,
    "state" "text" NOT NULL,
    "cleanup_from_state" "text",
    "reserved_bytes" bigint DEFAULT 0 NOT NULL,
    "outstanding_bytes" bigint DEFAULT 0 NOT NULL,
    "version" bigint DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "hard_expires_at" timestamp with time zone NOT NULL,
    "lease_until" timestamp with time zone,
    "retain_until" timestamp with time zone,
    "last_cleanup_attempt" timestamp with time zone,
    CONSTRAINT "private_transfers_authority_kind_check" CHECK (("authority_kind" = ANY (ARRAY['pat'::"text", 'oauth'::"text"]))),
    CONSTRAINT "private_transfers_check" CHECK ((("outstanding_bytes" >= 0) AND ("outstanding_bytes" <= "reserved_bytes"))),
    CONSTRAINT "private_transfers_check1" CHECK (("expires_at" <= "hard_expires_at")),
    CONSTRAINT "private_transfers_check2" CHECK ((("state" = ANY (ARRAY['cleanup_pending'::"text", 'closed'::"text"])) = ("cleanup_from_state" IS NOT NULL))),
    CONSTRAINT "private_transfers_check3" CHECK ((("state" <> 'closed'::"text") OR (("reserved_bytes" = 0) AND ("retain_until" IS NOT NULL)))),
    CONSTRAINT "private_transfers_direction_check" CHECK (("direction" = ANY (ARRAY['upload'::"text", 'download'::"text"]))),
    CONSTRAINT "private_transfers_reserved_bytes_check" CHECK (("reserved_bytes" >= 0)),
    CONSTRAINT "private_transfers_state_check" CHECK (("length"("state") > 0)),
    CONSTRAINT "private_transfers_version_check" CHECK (("version" > 0))
);

CREATE TABLE "private_upload_chunks" (
    "transfer_id" "uuid" NOT NULL,
    "chunk_id" "uuid" NOT NULL,
    "object_id" "uuid" NOT NULL,
    "byte_offset" bigint NOT NULL,
    "byte_size" bigint NOT NULL,
    "sha256" "text" NOT NULL,
    CONSTRAINT "private_upload_chunks_byte_offset_check" CHECK (("byte_offset" >= 0)),
    CONSTRAINT "private_upload_chunks_byte_size_check" CHECK ((("byte_size" > 0) AND ("byte_size" <= 524288))),
    CONSTRAINT "private_upload_chunks_check" CHECK (("byte_offset" <= ('9223372036854775807'::bigint - "byte_size"))),
    CONSTRAINT "private_upload_chunks_sha256_check" CHECK (("sha256" ~ '^[0-9a-f]{64}$'::"text"))
);

CREATE TABLE "project_github" (
    "project_id" "uuid" NOT NULL,
    "version" bigint DEFAULT 1 NOT NULL,
    "generation" bigint DEFAULT 0 NOT NULL,
    "revision" bigint DEFAULT 0 NOT NULL,
    "enabled" boolean DEFAULT false NOT NULL,
    "app_id" bigint,
    "installation_id" bigint,
    "repository_id" bigint,
    "installation_account_login" "text",
    "repository_full_name" "text",
    "repository_private" boolean,
    "poll_interval_minutes" integer DEFAULT 5 NOT NULL,
    "access_state" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "access_reason" "text",
    "access_checked_at" timestamp with time zone,
    "next_access_check_at" timestamp with time zone,
    "access_hint_id" "uuid",
    "access_delivery_id" "text",
    "next_poll_at" timestamp with time zone,
    "not_before" timestamp with time zone,
    "last_poll_attempt_at" timestamp with time zone,
    "last_full_success_at" timestamp with time zone,
    "last_full_generation" bigint,
    "poll_error_code" "text",
    "poll_error_message" "text",
    "poll_error_at" timestamp with time zone,
    "last_webhook_received_at" timestamp with time zone,
    "last_webhook_attempt_at" timestamp with time zone,
    "last_webhook_success_at" timestamp with time zone,
    "webhook_error_code" "text",
    "webhook_error_message" "text",
    "webhook_error_at" timestamp with time zone,
    "claim_token" "uuid",
    "claim_until" timestamp with time zone,
    "claim_kind" "text",
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "sync_enabled" boolean DEFAULT false NOT NULL,
    CONSTRAINT "project_github_sync_requires_connection" CHECK (((NOT "sync_enabled") OR "enabled"))
);

CREATE TABLE "project_github_pending_prs" (
    "project_id" "uuid" NOT NULL,
    "number" bigint NOT NULL,
    "generation" bigint NOT NULL,
    "request_id" "uuid" NOT NULL,
    "delivery_id" "text" NOT NULL,
    "received_at" timestamp with time zone NOT NULL,
    "next_attempt_at" timestamp with time zone NOT NULL
);

CREATE SEQUENCE "project_grant_versions"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE "project_grants" (
    "project_id" "uuid" CONSTRAINT "project_members_project_id_not_null" NOT NULL,
    "user_id" "uuid" CONSTRAINT "project_members_user_id_not_null" NOT NULL,
    "role" "text" CONSTRAINT "project_members_role_not_null" NOT NULL,
    "version" bigint DEFAULT "nextval"('"project_grant_versions"'::"regclass") CONSTRAINT "project_members_version_not_null" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() CONSTRAINT "project_members_created_at_not_null" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "statement_timestamp"() CONSTRAINT "project_members_updated_at_not_null" NOT NULL,
    CONSTRAINT "project_grants_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'member'::"text"]))),
    CONSTRAINT "project_grants_version_check" CHECK (("version" > 0))
);

CREATE TABLE "project_invitations" (
    "id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "token_hash" "bytea" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "consumed_by" "uuid",
    "consumed_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    CONSTRAINT "project_invitations_check" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "project_invitations_check1" CHECK ((("consumed_by" IS NULL) = ("consumed_at" IS NULL))),
    CONSTRAINT "project_invitations_check2" CHECK ((("consumed_at" IS NULL) OR ("revoked_at" IS NULL))),
    CONSTRAINT "project_invitations_token_hash_check" CHECK (("octet_length"("token_hash") = 32))
);

CREATE TABLE "project_ownership" (
    "project_id" "uuid" NOT NULL,
    "team_id" "uuid" NOT NULL,
    "version" bigint DEFAULT 1 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    CONSTRAINT "project_ownership_version_check" CHECK (("version" > 0))
);

CREATE TABLE "project_pull_requests" (
    "project_id" "uuid" NOT NULL,
    "number" bigint NOT NULL,
    "github_id" bigint NOT NULL,
    "url" "text" NOT NULL,
    "title" "text" NOT NULL,
    "author_id" bigint,
    "author_login" "text",
    "state" "text" NOT NULL,
    "draft" boolean NOT NULL,
    "base_ref" "text" NOT NULL,
    "head_repository_id" bigint,
    "head_repository_full_name" "text",
    "head_ref" "text",
    "head_sha" "text" NOT NULL,
    "github_created_at" timestamp with time zone NOT NULL,
    "github_updated_at" timestamp with time zone NOT NULL,
    "github_closed_at" timestamp with time zone,
    "github_merged_at" timestamp with time zone,
    "description" "text",
    "observed_at" timestamp with time zone NOT NULL,
    "revision" bigint NOT NULL,
    "seen_poll_id" "uuid"
);

CREATE TABLE "project_tags" (
    "id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "name_key" "text" NOT NULL COLLATE "pg_catalog"."C",
    "version" bigint DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE "projects" (
    "id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "repo_url" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "execution_warning_minutes" integer DEFAULT 60 NOT NULL,
    "settings_version" bigint DEFAULT 1 NOT NULL,
    "task_cache_epoch" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "deleted_at" timestamp with time zone,
    "tag_catalog_epoch" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    CONSTRAINT "projects_execution_warning_minutes_check" CHECK (("execution_warning_minutes" > 0)),
    CONSTRAINT "projects_name_check" CHECK (("btrim"("name") <> ''::"text")),
    CONSTRAINT "projects_repo_url_check" CHECK (("btrim"("repo_url") <> ''::"text")),
    CONSTRAINT "projects_settings_version_check" CHECK (("settings_version" > 0))
);

CREATE TABLE "schema_migrations" (
    "version" bigint NOT NULL,
    "checksum" "text" NOT NULL,
    "applied_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    CONSTRAINT "schema_migrations_checksum_check" CHECK (("length"("checksum") = 64))
);

CREATE TABLE "session_archive_bundles" (
    "session_id" "uuid" NOT NULL,
    "prepare_id" "uuid" NOT NULL,
    "phase" "text" NOT NULL,
    "revision" bigint NOT NULL,
    "identity" "jsonb" NOT NULL,
    "resources" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "ledger" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "history_id" "uuid",
    "timeline_id" "uuid",
    "manifest_path" "text" DEFAULT ''::"text" NOT NULL,
    "manifest_hash" "text" DEFAULT ''::"text" NOT NULL,
    "manifest_length" "text" DEFAULT ''::"text" NOT NULL
);

CREATE TABLE "session_archive_chunks" (
    "session_id" "uuid" NOT NULL,
    "file_id" "uuid" NOT NULL,
    "chunk_offset" bigint NOT NULL,
    "byte_length" bigint NOT NULL,
    "sha256" "text" NOT NULL,
    "object_path" "text" NOT NULL
);

CREATE TABLE "session_archive_files" (
    "session_id" "uuid" NOT NULL,
    "file_id" "uuid" NOT NULL,
    "purpose" "text" NOT NULL,
    "timeline_revision" bigint DEFAULT 1 NOT NULL,
    "staging_released" boolean DEFAULT false NOT NULL,
    "resource" "jsonb" DEFAULT 'null'::"jsonb" NOT NULL,
    "sha256" "text" NOT NULL,
    "byte_length" bigint NOT NULL,
    "accepted_offset" bigint NOT NULL,
    "state" "text" NOT NULL,
    "object_path" "text" NOT NULL
);

CREATE TABLE "session_archive_migrations" (
    "session_id" "uuid" NOT NULL,
    "migration_id" "uuid" NOT NULL,
    "source_path" "text" NOT NULL,
    "source_hash" "text" NOT NULL,
    "source_byte_length" bigint NOT NULL,
    "target_path" "text" DEFAULT ''::"text" NOT NULL,
    "target_hash" "text" DEFAULT ''::"text" NOT NULL,
    "phase" "text" NOT NULL
);

CREATE TABLE "session_archives" (
    "session_id" "uuid" NOT NULL,
    "state" "text" NOT NULL,
    "sha256" "text",
    "byte_length" bigint,
    "object_path" "text",
    "error_code" "text",
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "schema_version" integer DEFAULT 1 NOT NULL,
    "completeness" "text",
    "finalization_id" "uuid",
    "receipt" "jsonb",
    CONSTRAINT "session_archive_body" CHECK ((("schema_version" = 3) OR (("state" = 'ready'::"text") AND ("sha256" ~ '^[a-f0-9]{64}$'::"text") AND ("sha256" IS NOT NULL) AND (("byte_length" >= 1) AND ("byte_length" <= 67108864)) AND ("byte_length" IS NOT NULL) AND ("object_path" IS NOT NULL) AND ("error_code" IS NULL)) OR (("state" <> 'ready'::"text") AND ("sha256" IS NULL) AND ("byte_length" IS NULL) AND ("object_path" IS NULL)))),
    CONSTRAINT "session_archive_state" CHECK (("state" = ANY (ARRAY['pending'::"text", 'ready'::"text", 'failed'::"text", 'unavailable'::"text"]))),
    CONSTRAINT "session_archive_version" CHECK ((("schema_version" = 3) OR (("schema_version" = 1) AND ("state" <> 'unavailable'::"text") AND (("state" <> 'pending'::"text") OR ("error_code" IS NULL)) AND ("completeness" IS NULL) AND ("finalization_id" IS NULL) AND ("receipt" IS NULL)) OR (("schema_version" = 2) AND ((("state" = 'ready'::"text") AND ("completeness" = ANY (ARRAY['complete'::"text", 'partial'::"text"])) AND ("finalization_id" IS NOT NULL) AND ("receipt" IS NOT NULL)) OR (("state" = 'unavailable'::"text") AND ("completeness" IS NULL) AND ("finalization_id" IS NOT NULL) AND ("receipt" IS NOT NULL)) OR (("state" = ANY (ARRAY['pending'::"text", 'failed'::"text"])) AND ("completeness" IS NULL) AND ("receipt" IS NULL)))))),
    CONSTRAINT "session_archives_error_code_check" CHECK (("error_code" ~ '^[a-z_]{1,64}$'::"text"))
);

CREATE TABLE "session_events" (
    "session_id" "uuid" NOT NULL,
    "event_seq" bigint NOT NULL,
    "source_epoch" "uuid",
    "source_seq" bigint,
    "batch_id" "uuid",
    "source_body" "jsonb",
    "event" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL
);

CREATE TABLE "session_image_captures" (
    "session_id" "uuid" NOT NULL,
    "capture_id" "uuid" NOT NULL,
    "image_id" "uuid" NOT NULL,
    "request" "jsonb" NOT NULL,
    "receipt" "jsonb" NOT NULL,
    "validated" "jsonb"
);

CREATE TABLE "session_image_chunks" (
    "session_id" "uuid" NOT NULL,
    "upload_id" "uuid" NOT NULL,
    "chunk_offset" bigint NOT NULL,
    "byte_length" bigint NOT NULL,
    "sha256" "text" NOT NULL,
    "blob_path" "text" NOT NULL
);

CREATE TABLE "session_image_uploads" (
    "session_id" "uuid" NOT NULL,
    "upload_id" "uuid" NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "image_id" "uuid" NOT NULL,
    "blob_id" "uuid" NOT NULL,
    "spec" "jsonb" NOT NULL,
    "receipt" "jsonb" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "storage_released" boolean DEFAULT false NOT NULL
);

CREATE TABLE "session_media_rates" (
    "owner_user_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "tokens" bigint NOT NULL,
    "updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE "session_media_requests" (
    "session_id" "uuid" NOT NULL,
    "request_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "fence" "jsonb" NOT NULL,
    "body" "jsonb" NOT NULL,
    "result" "jsonb",
    "error" "jsonb",
    "complete" boolean DEFAULT false NOT NULL
);

CREATE TABLE "session_operation_intents" (
    "session_id" "uuid" NOT NULL,
    "operation_id" "uuid" NOT NULL,
    "canonical_bytes" "bytea" NOT NULL
);

CREATE TABLE "session_operations" (
    "session_id" "uuid" NOT NULL,
    "operation_id" "uuid" NOT NULL,
    "operation_seq" bigint NOT NULL,
    "body_hash" "bytea" NOT NULL,
    "command" "jsonb" NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "credential_id" "uuid" NOT NULL,
    "credential_kind" "text" NOT NULL,
    "receipt" "jsonb" NOT NULL,
    "dispatch_epoch" bigint,
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "deadline" timestamp with time zone DEFAULT ("statement_timestamp"() + '00:00:30'::interval) NOT NULL
);

CREATE TABLE "session_recording_evidence" (
    "session_id" "uuid" NOT NULL,
    "execution_generation" bigint NOT NULL,
    "evidence_id" "uuid" NOT NULL,
    "revision" bigint NOT NULL,
    "body_hash" "text" NOT NULL,
    CONSTRAINT "session_recording_evidence_body_hash_check" CHECK (("body_hash" ~ '^[a-f0-9]{64}$'::"text")),
    CONSTRAINT "session_recording_evidence_execution_generation_check" CHECK (("execution_generation" > 0)),
    CONSTRAINT "session_recording_evidence_revision_check" CHECK (("revision" > 0))
);

CREATE TABLE "session_resource_leases" (
    "session_id" "uuid" NOT NULL,
    "lease_id" "uuid" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "resource_id" "uuid",
    "delete_epoch" bigint NOT NULL
);

CREATE TABLE "session_resource_references" (
    "session_id" "uuid" NOT NULL,
    "resource_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "reference_id" "text" NOT NULL
);

CREATE TABLE "session_resource_state" (
    "session_id" "uuid" NOT NULL,
    "delete_epoch" bigint DEFAULT 0 NOT NULL,
    "deleting" boolean DEFAULT false NOT NULL
);

CREATE TABLE "session_resources" (
    "session_id" "uuid" NOT NULL,
    "resource_id" "uuid" NOT NULL,
    "descriptor" "jsonb" NOT NULL,
    "content" "bytea",
    "blob_id" "uuid",
    "gc_pending" boolean DEFAULT false NOT NULL,
    "blob_path" "text",
    "migration_id" "uuid",
    CONSTRAINT "session_resources_content_check" CHECK ((("content" IS NULL) OR ("octet_length"("content") <= 8388608)))
);

CREATE TABLE "session_source_hashes" (
    "session_id" "uuid" NOT NULL,
    "source_epoch" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "source_seq" bigint NOT NULL,
    "identity" "text" NOT NULL,
    "digest" "bytea" NOT NULL
);

CREATE TABLE "session_timeline" (
    "session_id" "uuid" NOT NULL,
    "entry_id" "uuid" NOT NULL,
    "entry_seq" bigint NOT NULL,
    "revision" bigint NOT NULL,
    "entry" "jsonb" NOT NULL
);

CREATE TABLE "sessions" (
    "id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "token_hash" "bytea" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    CONSTRAINT "sessions_check" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "sessions_token_hash_check" CHECK (("octet_length"("token_hash") = 32))
);

CREATE TABLE "task_attachments" (
    "project_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "path" "text" NOT NULL COLLATE "pg_catalog"."C",
    "content_type" "text" NOT NULL,
    "size_bytes" bigint NOT NULL,
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    CONSTRAINT "task_attachments_content_type_check" CHECK (("content_type" <> ''::"text")),
    CONSTRAINT "task_attachments_path_check" CHECK (("path" <> ''::"text")),
    CONSTRAINT "task_attachments_size_bytes_check" CHECK (("size_bytes" >= 0))
);

CREATE TABLE "task_dependencies" (
    "project_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "depends_on_task_id" "uuid" NOT NULL,
    "external" boolean DEFAULT false NOT NULL,
    CONSTRAINT "task_dependencies_check" CHECK (("task_id" <> "depends_on_task_id"))
);

CREATE TABLE "task_properties" (
    "task_id" "uuid" NOT NULL,
    "name" "text" NOT NULL COLLATE "pg_catalog"."C",
    "value" "text" NOT NULL,
    CONSTRAINT "task_properties_name_check" CHECK (("name" <> ''::"text"))
);

CREATE TABLE "tasks" (
    "id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'proposed'::"text" NOT NULL,
    "version" bigint DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "allow_agents" boolean DEFAULT false NOT NULL,
    "required_platform" "text",
    "deleted_at" timestamp with time zone,
    "assigned_to" "uuid",
    "cancelled_at" timestamp with time zone,
    "type" "text" DEFAULT 'task'::"text" NOT NULL,
    "parent_id" "uuid",
    CONSTRAINT "tasks_cancelled_at_check" CHECK ((("status" = 'cancelled'::"text") = ("cancelled_at" IS NOT NULL))),
    CONSTRAINT "tasks_required_platform_check" CHECK (("required_platform" = ANY (ARRAY['windows'::"text", 'linux'::"text", 'macos'::"text"]))),
    CONSTRAINT "tasks_status_check" CHECK (("status" = ANY (ARRAY['proposed'::"text", 'todo'::"text", 'in_progress'::"text", 'done'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "tasks_title_check" CHECK (("btrim"("title") <> ''::"text")),
    CONSTRAINT "tasks_version_check" CHECK (("version" > 0))
);

CREATE VIEW "task_resource_rows" AS
 SELECT "t"."id",
    "t"."project_id",
    "t"."title",
    "t"."description",
    "t"."status",
    "t"."version",
    "t"."created_at",
    "t"."updated_at",
    "t"."started_at",
    "t"."completed_at",
    "t"."allow_agents",
    "t"."required_platform",
    "t"."deleted_at",
    "t"."assigned_to",
    "t"."cancelled_at",
    "t"."type",
    "t"."parent_id",
    "p"."type" AS "parent_type",
    "p"."deleted_at" AS "parent_deleted_at",
    COALESCE("t"."deleted_at",
        CASE
            WHEN (("t"."type" = 'task'::"text") AND ("p"."type" = 'goal'::"text")) THEN "p"."deleted_at"
            ELSE NULL::timestamp with time zone
        END) AS "effective_deleted_at"
   FROM ("tasks" "t"
     LEFT JOIN "tasks" "p" ON ((("p"."project_id" = "t"."project_id") AND ("p"."id" = "t"."parent_id"))));

CREATE TABLE "task_sessions" (
    "id" "uuid" NOT NULL,
    "project_id" "uuid",
    "task_id" "uuid",
    "claim_id" "uuid",
    "owner_user_id" "uuid" NOT NULL,
    "registration_id" "uuid" NOT NULL,
    "registration" "jsonb" NOT NULL,
    "snapshot" "jsonb",
    "source_epoch" "uuid",
    "source_epochs" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "last_source_seq" bigint DEFAULT 0 NOT NULL,
    "last_operation_seq" bigint DEFAULT 0 NOT NULL,
    "server_instance" "uuid",
    "connected_at" timestamp with time zone,
    "last_seen" timestamp with time zone,
    "grant_hash" "bytea",
    "grant_expires_at" timestamp with time zone,
    "grant_kind" "text",
    "grant_consumed" boolean DEFAULT false NOT NULL,
    "parent_credential_id" "uuid",
    "connection_expires_at" timestamp with time zone,
    "stop_proof" "jsonb",
    "draining_until" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "connection_parent_credential_id" "uuid",
    "scope" "text" DEFAULT 'task'::"text" NOT NULL,
    "test_execution_id" "uuid",
    "draining_timeline_seq" bigint,
    "backend" "text" DEFAULT 'web'::"text" NOT NULL,
    "terminal_state" "jsonb",
    "bot_id" "uuid",
    CONSTRAINT "session_backend_content" CHECK (((("backend" = 'web'::"text") AND ("snapshot" IS NOT NULL) AND ("terminal_state" IS NULL)) OR (("backend" = 'herdr'::"text") AND ("scope" = 'task'::"text") AND ("snapshot" IS NULL) AND ("terminal_state" IS NOT NULL)))),
    CONSTRAINT "session_bot_scope" CHECK ((("bot_id" IS NULL) OR (("scope" = 'test'::"text") AND ("backend" = 'web'::"text")))),
    CONSTRAINT "session_scope_binding" CHECK (((("scope" = 'task'::"text") AND ("project_id" IS NOT NULL) AND ("task_id" IS NOT NULL) AND ("claim_id" IS NOT NULL) AND ("test_execution_id" IS NULL)) OR (("scope" = 'test'::"text") AND ("project_id" IS NULL) AND ("task_id" IS NULL) AND ("claim_id" IS NULL) AND ("test_execution_id" IS NOT NULL)))),
    CONSTRAINT "task_sessions_backend_check" CHECK (("backend" = ANY (ARRAY['web'::"text", 'herdr'::"text"])))
);

CREATE TABLE "task_steps" (
    "task_id" "uuid" NOT NULL,
    "id" "text" NOT NULL COLLATE "pg_catalog"."C",
    "position" bigint NOT NULL,
    "title" "text" NOT NULL,
    "description" "text" NOT NULL,
    "status" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL,
    CONSTRAINT "task_steps_id_check" CHECK (("id" ~ '^[0-9a-f]{8}$'::"text")),
    CONSTRAINT "task_steps_position_check" CHECK (("position" >= 0)),
    CONSTRAINT "task_steps_status_check" CHECK (("status" = ANY (ARRAY['todo'::"text", 'in_progress'::"text", 'done'::"text", 'skipped'::"text"])))
);

CREATE TABLE "task_tags" (
    "project_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "tag_id" "uuid" NOT NULL
);

CREATE TABLE "task_thread_messages" (
    "task_id" "uuid" NOT NULL,
    "message_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_at" timestamp(3) with time zone NOT NULL,
    "author_user_id" "uuid" NOT NULL,
    "author_display_name" "text",
    "author_agent" boolean NOT NULL,
    "author_claim_id" "uuid",
    "author_worker_id" "uuid",
    "author_provider" "text",
    "body" "text" NOT NULL,
    "reply_to_message_id" "uuid",
    CONSTRAINT "task_thread_messages_check" CHECK ((((NOT "author_agent") AND ("author_claim_id" IS NULL) AND ("author_worker_id" IS NULL) AND ("author_provider" IS NULL)) OR ("author_agent" AND ("author_claim_id" IS NOT NULL) AND ("author_worker_id" IS NOT NULL) AND ("author_provider" IS NOT NULL) AND ("author_provider" = ANY (ARRAY['codex'::"text", 'claude'::"text", 'copilot'::"text"])))))
);

CREATE TABLE "task_threads" (
    "task_id" "uuid" NOT NULL,
    "last_created_at" timestamp(3) with time zone,
    "last_message_id" "uuid",
    CONSTRAINT "task_threads_check" CHECK ((("last_created_at" IS NULL) = ("last_message_id" IS NULL)))
);

CREATE TABLE "team_invitations" (
    "id" "uuid" NOT NULL,
    "team_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "token_hash" "bytea" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "consumed_by" "uuid",
    "consumed_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    CONSTRAINT "team_invitations_check" CHECK (("expires_at" > "created_at")),
    CONSTRAINT "team_invitations_check1" CHECK ((("consumed_by" IS NULL) = ("consumed_at" IS NULL))),
    CONSTRAINT "team_invitations_check2" CHECK ((("consumed_at" IS NULL) OR ("revoked_at" IS NULL))),
    CONSTRAINT "team_invitations_token_hash_check" CHECK (("octet_length"("token_hash") = 32))
);

CREATE SEQUENCE "team_member_versions"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE "team_members" (
    "team_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "version" bigint DEFAULT "nextval"('"team_member_versions"'::"regclass") NOT NULL,
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    CONSTRAINT "team_members_role_check" CHECK (("role" = ANY (ARRAY['admin'::"text", 'member'::"text"]))),
    CONSTRAINT "team_members_version_check" CHECK (("version" > 0))
);

CREATE TABLE "teams" (
    "id" "uuid" NOT NULL,
    "personal_user_id" "uuid",
    "name" "text",
    "version" bigint DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    CONSTRAINT "teams_check" CHECK (((("personal_user_id" IS NOT NULL) AND ("name" IS NULL)) OR (("personal_user_id" IS NULL) AND ("name" IS NOT NULL)))),
    CONSTRAINT "teams_version_check" CHECK (("version" > 0))
);

CREATE TABLE "users" (
    "id" "uuid" NOT NULL,
    "uniauth_id" "text" NOT NULL,
    "email" "text",
    "email_verified" boolean,
    "name" "text",
    "avatar_url" "text",
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL,
    CONSTRAINT "users_uniauth_id_check" CHECK (("length"("uniauth_id") > 0))
);

CREATE TABLE "webhook_attempts" (
    "id" "uuid" NOT NULL,
    "delivery_id" "uuid" NOT NULL,
    "endpoint_id" "uuid" NOT NULL,
    "generation" bigint NOT NULL,
    "sequence" smallint NOT NULL,
    "trigger" "text" NOT NULL,
    "lease_token" "uuid" NOT NULL,
    "destination_revision" bigint NOT NULL,
    "signing_key_ids" "uuid"[] NOT NULL,
    "automatic_plan_slot" smallint,
    "manual_operation_id" "uuid",
    "claimed_at" timestamp with time zone NOT NULL,
    "admitted_at" timestamp with time zone NOT NULL,
    "retention_closed_at" timestamp with time zone,
    "dispatched_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "outcome" "text",
    "http_status" smallint,
    "duration_ms" bigint,
    "error_code" "text",
    "retry_after_not_before" timestamp with time zone,
    "retry_after_diagnostic_code" "text",
    "recovered_unknown_at" timestamp with time zone,
    "late_observed_at" timestamp with time zone,
    "late_outcome" "text",
    "late_http_status" smallint,
    "late_duration_ms" bigint,
    "late_error_code" "text",
    "late_retry_after_not_before" timestamp with time zone,
    "late_retry_after_diagnostic_code" "text",
    CONSTRAINT "webhook_attempts_admitted_at_check" CHECK ("isfinite"("admitted_at")),
    CONSTRAINT "webhook_attempts_check" CHECK (((("trigger" = 'automatic'::"text") AND (("automatic_plan_slot" >= 1) AND ("automatic_plan_slot" <= 10)) AND ("automatic_plan_slot" IS NOT NULL) AND ("manual_operation_id" IS NULL)) OR (("trigger" = 'manual'::"text") AND ("automatic_plan_slot" IS NULL) AND ("manual_operation_id" IS NOT NULL)))),
    CONSTRAINT "webhook_attempts_check1" CHECK (((("finished_at" IS NULL) AND ("outcome" IS NULL) AND ("http_status" IS NULL) AND ("duration_ms" IS NULL) AND ("error_code" IS NULL) AND ("retry_after_not_before" IS NULL) AND ("retry_after_diagnostic_code" IS NULL)) OR (("finished_at" IS NOT NULL) AND ("outcome" IS NOT NULL)))),
    CONSTRAINT "webhook_attempts_check2" CHECK ((("retry_after_not_before" IS NULL) OR ("retry_after_diagnostic_code" IS NULL))),
    CONSTRAINT "webhook_attempts_check3" CHECK (((("late_observed_at" IS NULL) AND ("late_outcome" IS NULL) AND ("late_http_status" IS NULL) AND ("late_duration_ms" IS NULL) AND ("late_error_code" IS NULL) AND ("late_retry_after_not_before" IS NULL) AND ("late_retry_after_diagnostic_code" IS NULL)) OR (("late_observed_at" IS NOT NULL) AND ("late_outcome" IS NOT NULL) AND ("recovered_unknown_at" IS NOT NULL)))),
    CONSTRAINT "webhook_attempts_check4" CHECK ((("late_retry_after_not_before" IS NULL) OR ("late_retry_after_diagnostic_code" IS NULL))),
    CONSTRAINT "webhook_attempts_claimed_at_check" CHECK ("isfinite"("claimed_at")),
    CONSTRAINT "webhook_attempts_destination_revision_check" CHECK (("destination_revision" > 0)),
    CONSTRAINT "webhook_attempts_dispatched_at_check" CHECK ("isfinite"("dispatched_at")),
    CONSTRAINT "webhook_attempts_duration_ms_check" CHECK (("duration_ms" >= 0)),
    CONSTRAINT "webhook_attempts_finished_at_check" CHECK ("isfinite"("finished_at")),
    CONSTRAINT "webhook_attempts_generation_check" CHECK (("generation" > 0)),
    CONSTRAINT "webhook_attempts_http_status_check" CHECK ((("http_status" >= 100) AND ("http_status" <= 599))),
    CONSTRAINT "webhook_attempts_late_duration_ms_check" CHECK (("late_duration_ms" >= 0)),
    CONSTRAINT "webhook_attempts_late_http_status_check" CHECK ((("late_http_status" >= 100) AND ("late_http_status" <= 599))),
    CONSTRAINT "webhook_attempts_late_observed_at_check" CHECK ("isfinite"("late_observed_at")),
    CONSTRAINT "webhook_attempts_late_outcome_check" CHECK (("late_outcome" = ANY (ARRAY['acknowledged'::"text", 'http_error'::"text", 'receiver_error'::"text", 'transport_error'::"text", 'unknown'::"text", 'cancelled'::"text", 'policy_denied'::"text", 'render_error'::"text"]))),
    CONSTRAINT "webhook_attempts_late_retry_after_diagnostic_code_check" CHECK (("late_retry_after_diagnostic_code" = 'invalid_retry_after'::"text")),
    CONSTRAINT "webhook_attempts_late_retry_after_not_before_check" CHECK ("isfinite"("late_retry_after_not_before")),
    CONSTRAINT "webhook_attempts_outcome_check" CHECK (("outcome" = ANY (ARRAY['acknowledged'::"text", 'http_error'::"text", 'receiver_error'::"text", 'transport_error'::"text", 'unknown'::"text", 'cancelled'::"text", 'policy_denied'::"text", 'render_error'::"text"]))),
    CONSTRAINT "webhook_attempts_recovered_unknown_at_check" CHECK ("isfinite"("recovered_unknown_at")),
    CONSTRAINT "webhook_attempts_retention_closed_at_check" CHECK ("isfinite"("retention_closed_at")),
    CONSTRAINT "webhook_attempts_retry_after_diagnostic_code_check" CHECK (("retry_after_diagnostic_code" = 'invalid_retry_after'::"text")),
    CONSTRAINT "webhook_attempts_retry_after_not_before_check" CHECK ("isfinite"("retry_after_not_before")),
    CONSTRAINT "webhook_attempts_sequence_check" CHECK ((("sequence" >= 1) AND ("sequence" <= 13))),
    CONSTRAINT "webhook_attempts_signing_key_ids_check" CHECK ((("array_ndims"("signing_key_ids") = 1) AND ("array_lower"("signing_key_ids", 1) = 1) AND (("cardinality"("signing_key_ids") >= 1) AND ("cardinality"("signing_key_ids") <= 2)) AND ("array_position"("signing_key_ids", NULL::"uuid") IS NULL) AND (("cardinality"("signing_key_ids") = 1) OR ("signing_key_ids"[1] <> "signing_key_ids"[2])))),
    CONSTRAINT "webhook_attempts_trigger_check" CHECK (("trigger" = ANY (ARRAY['automatic'::"text", 'manual'::"text"])))
);

CREATE TABLE "webhook_bindings" (
    "id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "webhook_bindings_created_at_check" CHECK ("isfinite"("created_at")),
    CONSTRAINT "webhook_bindings_deleted_at_check" CHECK ("isfinite"("deleted_at"))
);

CREATE SEQUENCE "webhook_delivery_queue_order_seq"
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE TABLE "webhook_deliveries" (
    "id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "endpoint_id" "uuid" NOT NULL,
    "owner_kind" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "occurred_at" timestamp with time zone NOT NULL,
    "original_match_count" bigint NOT NULL,
    "original_match_sha256" "bytea" NOT NULL,
    "policy_version" bigint NOT NULL,
    "destination_revision" bigint NOT NULL,
    "destination_kind" "text" NOT NULL,
    "adapter_version" bigint NOT NULL,
    "render_version" smallint NOT NULL,
    "configuration_schema_version" smallint NOT NULL,
    "destination_origin" "text" NOT NULL,
    "destination_configuration" "bytea" NOT NULL,
    "request_method" "text" NOT NULL,
    "request_media_type" "text" NOT NULL,
    "deterministic_headers_json" "bytea" NOT NULL,
    "body" "bytea",
    "original_body_bytes" integer NOT NULL,
    "body_sha256" "bytea" NOT NULL,
    "payload_removed_at" timestamp with time zone,
    "payload_removed_reason" "text",
    "automatic_schedule_at" timestamp with time zone[] NOT NULL,
    "automatic_expires_at" timestamp with time zone NOT NULL,
    "payload_expires_at" timestamp with time zone NOT NULL,
    "automatic_plan_cursor" smallint NOT NULL,
    "automatic_open" boolean NOT NULL,
    "automatic_attempt_count" smallint NOT NULL,
    "manual_operation_count" smallint NOT NULL,
    "attempt_sequence" smallint NOT NULL,
    "generation" bigint NOT NULL,
    "state" "text" NOT NULL,
    "trigger" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "next_attempt_at" timestamp with time zone,
    "manual_operation_id" "uuid",
    "lease_token" "uuid",
    "lease_claimed_at" timestamp with time zone,
    "lease_until" timestamp with time zone,
    "lease_generation" bigint,
    "lease_plan_slot" smallint,
    "current_attempt_id" "uuid",
    "terminal_at" timestamp with time zone,
    "last_activity_at" timestamp with time zone NOT NULL,
    "metadata_expires_at" timestamp with time zone NOT NULL,
    "preparation_error_code" "text",
    "queue_order" bigint DEFAULT "nextval"('"webhook_delivery_queue_order_seq"'::"regclass") NOT NULL,
    "purging_at" timestamp with time zone,
    CONSTRAINT "webhook_deliveries_adapter_version_check" CHECK (("adapter_version" = 1)),
    CONSTRAINT "webhook_deliveries_attempt_sequence_check" CHECK ((("attempt_sequence" >= 0) AND ("attempt_sequence" <= 13))),
    CONSTRAINT "webhook_deliveries_automatic_attempt_count_check" CHECK ((("automatic_attempt_count" >= 0) AND ("automatic_attempt_count" <= 10))),
    CONSTRAINT "webhook_deliveries_automatic_expires_at_check" CHECK ("isfinite"("automatic_expires_at")),
    CONSTRAINT "webhook_deliveries_automatic_plan_cursor_check" CHECK ((("automatic_plan_cursor" >= 0) AND ("automatic_plan_cursor" <= 10))),
    CONSTRAINT "webhook_deliveries_automatic_schedule_at_check" CHECK ((("array_ndims"("automatic_schedule_at") = 1) AND ("array_lower"("automatic_schedule_at", 1) = 1) AND ("cardinality"("automatic_schedule_at") = 10) AND ("array_position"("automatic_schedule_at", NULL::timestamp with time zone) IS NULL) AND "isfinite"("automatic_schedule_at"[1]) AND "isfinite"("automatic_schedule_at"[10]) AND ("automatic_schedule_at"[1] < "automatic_schedule_at"[2]) AND ("automatic_schedule_at"[2] < "automatic_schedule_at"[3]) AND ("automatic_schedule_at"[3] < "automatic_schedule_at"[4]) AND ("automatic_schedule_at"[4] < "automatic_schedule_at"[5]) AND ("automatic_schedule_at"[5] < "automatic_schedule_at"[6]) AND ("automatic_schedule_at"[6] < "automatic_schedule_at"[7]) AND ("automatic_schedule_at"[7] < "automatic_schedule_at"[8]) AND ("automatic_schedule_at"[8] < "automatic_schedule_at"[9]) AND ("automatic_schedule_at"[9] < "automatic_schedule_at"[10]))),
    CONSTRAINT "webhook_deliveries_body_sha256_check" CHECK (("octet_length"("body_sha256") = 32)),
    CONSTRAINT "webhook_deliveries_check" CHECK (((("body" IS NOT NULL) AND ("payload_removed_at" IS NULL) AND ("payload_removed_reason" IS NULL) AND ("octet_length"("body") = "original_body_bytes") AND ("sha256"("body") = "body_sha256")) OR (("body" IS NULL) AND ("payload_removed_at" IS NOT NULL) AND ("payload_removed_reason" = 'expired'::"text") AND ("payload_removed_reason" IS NOT NULL)))),
    CONSTRAINT "webhook_deliveries_check1" CHECK ((("policy_version" <> 1) OR (("automatic_schedule_at"[1] = "occurred_at") AND ("automatic_schedule_at"[10] < "automatic_expires_at") AND ("automatic_expires_at" = ("occurred_at" + '72:00:00'::interval)) AND ("payload_expires_at" = ("occurred_at" + '168:00:00'::interval))))),
    CONSTRAINT "webhook_deliveries_check2" CHECK (((("lease_token" IS NULL) AND ("lease_claimed_at" IS NULL) AND ("lease_until" IS NULL) AND ("lease_generation" IS NULL) AND ("lease_plan_slot" IS NULL) AND ("current_attempt_id" IS NULL) AND ("state" <> 'leased'::"text")) OR (("lease_token" IS NOT NULL) AND ("lease_claimed_at" IS NOT NULL) AND ("lease_until" IS NOT NULL) AND ("lease_until" > "lease_claimed_at") AND ("lease_generation" IS NOT NULL) AND ("lease_generation" = "generation") AND ("state" = 'leased'::"text")))),
    CONSTRAINT "webhook_deliveries_configuration_schema_version_check" CHECK (("configuration_schema_version" = 1)),
    CONSTRAINT "webhook_deliveries_destination_configuration_check" CHECK ((("octet_length"("destination_configuration") >= 1) AND ("octet_length"("destination_configuration") <= 262144))),
    CONSTRAINT "webhook_deliveries_destination_kind_check" CHECK (("destination_kind" = 'http'::"text")),
    CONSTRAINT "webhook_deliveries_destination_origin_check" CHECK (("octet_length"("destination_origin") > 0)),
    CONSTRAINT "webhook_deliveries_destination_revision_check" CHECK (("destination_revision" > 0)),
    CONSTRAINT "webhook_deliveries_deterministic_headers_json_check" CHECK (("deterministic_headers_json" = "convert_to"('[]'::"text", 'UTF8'::"name"))),
    CONSTRAINT "webhook_deliveries_event_type_check" CHECK (("event_type" = ANY (ARRAY['task.created'::"text", 'task.status_changed'::"text", 'task.paused'::"text", 'task.deleted'::"text", 'task.step_updated'::"text", 'task.thread_posted'::"text"]))),
    CONSTRAINT "webhook_deliveries_expires_at_check" CHECK ("isfinite"("expires_at")),
    CONSTRAINT "webhook_deliveries_generation_check" CHECK (("generation" > 0)),
    CONSTRAINT "webhook_deliveries_last_activity_at_check" CHECK ("isfinite"("last_activity_at")),
    CONSTRAINT "webhook_deliveries_lease_claimed_at_check" CHECK ("isfinite"("lease_claimed_at")),
    CONSTRAINT "webhook_deliveries_lease_plan_slot_check" CHECK ((("lease_plan_slot" >= 1) AND ("lease_plan_slot" <= 10))),
    CONSTRAINT "webhook_deliveries_lease_until_check" CHECK ("isfinite"("lease_until")),
    CONSTRAINT "webhook_deliveries_manual_operation_count_check" CHECK ((("manual_operation_count" >= 0) AND ("manual_operation_count" <= 3))),
    CONSTRAINT "webhook_deliveries_metadata_expires_at_check" CHECK ("isfinite"("metadata_expires_at")),
    CONSTRAINT "webhook_deliveries_next_attempt_at_check" CHECK ("isfinite"("next_attempt_at")),
    CONSTRAINT "webhook_deliveries_occurred_at_check" CHECK ("isfinite"("occurred_at")),
    CONSTRAINT "webhook_deliveries_original_body_bytes_check" CHECK ((("original_body_bytes" >= 1) AND ("original_body_bytes" <= 65536))),
    CONSTRAINT "webhook_deliveries_original_match_count_check" CHECK (("original_match_count" > 0)),
    CONSTRAINT "webhook_deliveries_original_match_sha256_check" CHECK (("octet_length"("original_match_sha256") = 32)),
    CONSTRAINT "webhook_deliveries_owner_kind_check" CHECK (("owner_kind" = ANY (ARRAY['personal'::"text", 'team'::"text"]))),
    CONSTRAINT "webhook_deliveries_payload_expires_at_check" CHECK ("isfinite"("payload_expires_at")),
    CONSTRAINT "webhook_deliveries_payload_removed_at_check" CHECK ("isfinite"("payload_removed_at")),
    CONSTRAINT "webhook_deliveries_policy_version_check" CHECK (("policy_version" > 0)),
    CONSTRAINT "webhook_deliveries_purging_at_check" CHECK ("isfinite"("purging_at")),
    CONSTRAINT "webhook_deliveries_queue_order_check" CHECK (("queue_order" > 0)),
    CONSTRAINT "webhook_deliveries_render_version_check" CHECK (("render_version" = 1)),
    CONSTRAINT "webhook_deliveries_request_media_type_check" CHECK (("request_media_type" = 'application/cloudevents+json'::"text")),
    CONSTRAINT "webhook_deliveries_request_method_check" CHECK (("request_method" = 'POST'::"text")),
    CONSTRAINT "webhook_deliveries_state_check" CHECK (("state" = ANY (ARRAY['pending'::"text", 'leased'::"text", 'delivered'::"text", 'failed'::"text", 'suppressed'::"text"]))),
    CONSTRAINT "webhook_deliveries_terminal_at_check" CHECK ("isfinite"("terminal_at")),
    CONSTRAINT "webhook_deliveries_trigger_check" CHECK (("trigger" = ANY (ARRAY['automatic'::"text", 'manual'::"text"])))
);

CREATE TABLE "webhook_delivery_matches" (
    "delivery_id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "binding_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "authorization_epoch" bigint NOT NULL,
    CONSTRAINT "webhook_delivery_matches_authorization_epoch_check" CHECK (("authorization_epoch" > 0)),
    CONSTRAINT "webhook_delivery_matches_event_type_check" CHECK (("event_type" = ANY (ARRAY['task.created'::"text", 'task.status_changed'::"text", 'task.paused'::"text", 'task.deleted'::"text", 'task.step_updated'::"text", 'task.thread_posted'::"text"])))
);

CREATE TABLE "webhook_endpoint_waits" (
    "endpoint_id" "uuid" NOT NULL,
    "destination_revision" bigint NOT NULL,
    "owner_kind" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "not_before" timestamp with time zone,
    "updated_at" timestamp with time zone NOT NULL,
    CONSTRAINT "webhook_endpoint_waits_destination_revision_check" CHECK (("destination_revision" > 0)),
    CONSTRAINT "webhook_endpoint_waits_not_before_check" CHECK ("isfinite"("not_before")),
    CONSTRAINT "webhook_endpoint_waits_owner_kind_check" CHECK (("owner_kind" = ANY (ARRAY['personal'::"text", 'team'::"text"]))),
    CONSTRAINT "webhook_endpoint_waits_updated_at_check" CHECK ("isfinite"("updated_at"))
);

CREATE TABLE "webhook_endpoints" (
    "id" "uuid" NOT NULL,
    "owner_kind" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "name" "text",
    "enabled" boolean NOT NULL,
    "config_version" bigint NOT NULL,
    "destination_revision" bigint NOT NULL,
    "destination_kind" "text",
    "adapter_version" bigint,
    "configuration_schema_version" smallint,
    "destination_origin" "text",
    "destination_configuration" "bytea",
    "active_key_id" "uuid",
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "webhook_endpoints_check" CHECK (((("deleted_at" IS NULL) AND ("name" IS NOT NULL) AND (("char_length"("name") >= 1) AND ("char_length"("name") <= 120)) AND ("destination_kind" = 'http'::"text") AND ("adapter_version" = 1) AND ("configuration_schema_version" = 1) AND ("destination_origin" IS NOT NULL) AND ("destination_configuration" IS NOT NULL) AND (("octet_length"("destination_configuration") >= 1) AND ("octet_length"("destination_configuration") <= 262144)) AND ("active_key_id" IS NOT NULL) AND ("destination_kind" IS NOT NULL) AND ("adapter_version" IS NOT NULL) AND ("configuration_schema_version" IS NOT NULL)) OR (("deleted_at" IS NOT NULL) AND (NOT "enabled") AND ("name" IS NULL) AND ("destination_kind" IS NULL) AND ("adapter_version" IS NULL) AND ("configuration_schema_version" IS NULL) AND ("destination_origin" IS NULL) AND ("destination_configuration" IS NULL) AND ("active_key_id" IS NULL)))),
    CONSTRAINT "webhook_endpoints_config_version_check" CHECK (("config_version" > 0)),
    CONSTRAINT "webhook_endpoints_created_at_check" CHECK ("isfinite"("created_at")),
    CONSTRAINT "webhook_endpoints_deleted_at_check" CHECK ("isfinite"("deleted_at")),
    CONSTRAINT "webhook_endpoints_destination_revision_check" CHECK (("destination_revision" > 0)),
    CONSTRAINT "webhook_endpoints_owner_kind_check" CHECK (("owner_kind" = ANY (ARRAY['personal'::"text", 'team'::"text"]))),
    CONSTRAINT "webhook_endpoints_updated_at_check" CHECK ("isfinite"("updated_at"))
);

CREATE TABLE "webhook_events" (
    "id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "wire_version" smallint NOT NULL,
    "schema_version" smallint NOT NULL,
    "source" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "task_id" "uuid" NOT NULL,
    "task_version" bigint,
    "task_deleted_at" timestamp with time zone,
    "step_id" bigint,
    "message_id" "uuid",
    "occurred_at" timestamp with time zone NOT NULL,
    "recorded_at" timestamp with time zone NOT NULL,
    "origin_request_id" "text",
    "fact_codec_version" smallint NOT NULL,
    "fact_bytes" "bytea",
    "fact_sha256" "bytea" NOT NULL,
    "original_fact_bytes" integer NOT NULL,
    "fact_removed_at" timestamp with time zone,
    CONSTRAINT "webhook_events_check" CHECK (("source" = ('urn:daynight:project:'::"text" || ("project_id")::"text"))),
    CONSTRAINT "webhook_events_check1" CHECK (((("event_type" = 'task.thread_posted'::"text") AND ("task_version" IS NULL) AND ("task_deleted_at" IS NULL) AND ("step_id" IS NULL) AND ("message_id" IS NOT NULL) AND ("subject" = ((('tasks/'::"text" || ("task_id")::"text") || '/thread/'::"text") || ("message_id")::"text"))) OR (("event_type" = 'task.step_updated'::"text") AND ("task_version" > 0) AND ("task_version" IS NOT NULL) AND ("task_deleted_at" IS NULL) AND (("step_id" >= 0) AND ("step_id" <= '4294967295'::bigint)) AND ("step_id" IS NOT NULL) AND ("message_id" IS NULL) AND ("subject" = (('tasks/'::"text" || ("task_id")::"text") || '/steps'::"text"))) OR (("event_type" = 'task.deleted'::"text") AND ("task_version" > 0) AND ("task_version" IS NOT NULL) AND ("task_deleted_at" IS NOT NULL) AND ("step_id" IS NULL) AND ("message_id" IS NULL) AND ("subject" = ('tasks/'::"text" || ("task_id")::"text"))) OR (("event_type" = ANY (ARRAY['task.created'::"text", 'task.status_changed'::"text", 'task.paused'::"text"])) AND ("task_version" > 0) AND ("task_version" IS NOT NULL) AND ("task_deleted_at" IS NULL) AND ("step_id" IS NULL) AND ("message_id" IS NULL) AND ("subject" = ('tasks/'::"text" || ("task_id")::"text"))))),
    CONSTRAINT "webhook_events_check2" CHECK (((("fact_bytes" IS NOT NULL) AND ("fact_removed_at" IS NULL) AND ("octet_length"("fact_bytes") = "original_fact_bytes") AND ("sha256"("fact_bytes") = "fact_sha256")) OR (("fact_bytes" IS NULL) AND ("fact_removed_at" IS NOT NULL)))),
    CONSTRAINT "webhook_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['task.created'::"text", 'task.status_changed'::"text", 'task.paused'::"text", 'task.deleted'::"text", 'task.step_updated'::"text", 'task.thread_posted'::"text"]))),
    CONSTRAINT "webhook_events_fact_codec_version_check" CHECK (("fact_codec_version" = 1)),
    CONSTRAINT "webhook_events_fact_removed_at_check" CHECK ("isfinite"("fact_removed_at")),
    CONSTRAINT "webhook_events_fact_sha256_check" CHECK (("octet_length"("fact_sha256") = 32)),
    CONSTRAINT "webhook_events_occurred_at_check" CHECK ("isfinite"("occurred_at")),
    CONSTRAINT "webhook_events_origin_request_id_check" CHECK ((("octet_length"("origin_request_id") >= 1) AND ("octet_length"("origin_request_id") <= 128))),
    CONSTRAINT "webhook_events_original_fact_bytes_check" CHECK ((("original_fact_bytes" >= 1) AND ("original_fact_bytes" <= 65536))),
    CONSTRAINT "webhook_events_recorded_at_check" CHECK ("isfinite"("recorded_at")),
    CONSTRAINT "webhook_events_schema_version_check" CHECK (("schema_version" = 1)),
    CONSTRAINT "webhook_events_task_deleted_at_check" CHECK ("isfinite"("task_deleted_at")),
    CONSTRAINT "webhook_events_wire_version_check" CHECK (("wire_version" = 1))
);

CREATE TABLE "webhook_operations" (
    "owner_kind" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "operation_id" "uuid" NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "endpoint_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "issued_at_lexeme" "text" NOT NULL,
    "request_sha256" "bytea" NOT NULL,
    "fingerprint_version" smallint NOT NULL,
    "semantic_fingerprint" "bytea" NOT NULL,
    "effect" "text" NOT NULL,
    "config_version_after" bigint NOT NULL,
    "destination_revision_after" bigint NOT NULL,
    "key_id_after" "uuid",
    "signing_mode_after" "text",
    "overlap_until_after" timestamp with time zone,
    "recorded_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "delivery_id" "uuid",
    "generation_after" bigint,
    CONSTRAINT "webhook_operations_check" CHECK (("isfinite"("expires_at") AND ("expires_at" > "recorded_at"))),
    CONSTRAINT "webhook_operations_check1" CHECK (((("kind" = 'signing-secret.rotate'::"text") AND ("key_id_after" IS NOT NULL) AND ((("signing_mode_after" = 'overlap'::"text") AND ("overlap_until_after" IS NOT NULL)) OR (("signing_mode_after" = 'immediate'::"text") AND ("overlap_until_after" IS NULL))) AND ("signing_mode_after" IS NOT NULL)) OR (("kind" <> 'signing-secret.rotate'::"text") AND ("key_id_after" IS NULL) AND ("signing_mode_after" IS NULL) AND ("overlap_until_after" IS NULL)))),
    CONSTRAINT "webhook_operations_config_version_after_check" CHECK (("config_version_after" > 0)),
    CONSTRAINT "webhook_operations_destination_revision_after_check" CHECK (("destination_revision_after" > 0)),
    CONSTRAINT "webhook_operations_effect_check" CHECK (("effect" = ANY (ARRAY['applied'::"text", 'unchanged'::"text"]))),
    CONSTRAINT "webhook_operations_fingerprint_version_check" CHECK (("fingerprint_version" = 1)),
    CONSTRAINT "webhook_operations_kind_check" CHECK (("kind" = ANY (ARRAY['endpoint.create'::"text", 'endpoint.patch'::"text", 'endpoint.delete'::"text", 'signing-secret.rotate'::"text", 'delivery.redeliver'::"text"]))),
    CONSTRAINT "webhook_operations_overlap_until_after_check" CHECK ("isfinite"("overlap_until_after")),
    CONSTRAINT "webhook_operations_owner_kind_check" CHECK (("owner_kind" = ANY (ARRAY['personal'::"text", 'team'::"text"]))),
    CONSTRAINT "webhook_operations_recorded_at_check" CHECK ("isfinite"("recorded_at")),
    CONSTRAINT "webhook_operations_redelivery_check" CHECK (((("kind" = 'delivery.redeliver'::"text") AND ("delivery_id" IS NOT NULL) AND ("generation_after" IS NOT NULL) AND ("generation_after" > 0)) OR (("kind" <> 'delivery.redeliver'::"text") AND ("delivery_id" IS NULL) AND ("generation_after" IS NULL)))),
    CONSTRAINT "webhook_operations_request_sha256_check" CHECK (("octet_length"("request_sha256") = 32)),
    CONSTRAINT "webhook_operations_semantic_fingerprint_check" CHECK (("octet_length"("semantic_fingerprint") = 32))
);

CREATE TABLE "webhook_policies" (
    "version" bigint NOT NULL,
    "max_automatic_attempts" smallint NOT NULL,
    "automatic_window_seconds" integer NOT NULL,
    "automatic_offsets_seconds" integer[] NOT NULL,
    "max_manual_operations" smallint NOT NULL,
    "payload_retention_seconds" integer NOT NULL,
    "metadata_retention_seconds" integer NOT NULL,
    "operation_retention_seconds" integer NOT NULL,
    "operation_max_age_seconds" integer NOT NULL,
    "operation_future_skew_seconds" integer NOT NULL,
    "http_timeout_seconds" integer NOT NULL,
    "lease_seconds" integer NOT NULL,
    "minimum_failure_wait_seconds" integer NOT NULL,
    "jitter_basis_points" integer NOT NULL,
    "jitter_max_seconds" integer NOT NULL,
    "key_overlap_default_seconds" integer NOT NULL,
    "key_overlap_max_seconds" integer NOT NULL,
    CONSTRAINT "webhook_policies_automatic_window_seconds_check" CHECK (("automatic_window_seconds" > 0)),
    CONSTRAINT "webhook_policies_check" CHECK ((("array_ndims"("automatic_offsets_seconds") = 1) AND ("array_lower"("automatic_offsets_seconds", 1) = 1) AND ("array_position"("automatic_offsets_seconds", NULL::integer) IS NULL) AND ("cardinality"("automatic_offsets_seconds") = "max_automatic_attempts"))),
    CONSTRAINT "webhook_policies_check1" CHECK (("key_overlap_max_seconds" >= "key_overlap_default_seconds")),
    CONSTRAINT "webhook_policies_http_timeout_seconds_check" CHECK (("http_timeout_seconds" > 0)),
    CONSTRAINT "webhook_policies_jitter_basis_points_check" CHECK ((("jitter_basis_points" >= 0) AND ("jitter_basis_points" <= 10000))),
    CONSTRAINT "webhook_policies_jitter_max_seconds_check" CHECK (("jitter_max_seconds" >= 0)),
    CONSTRAINT "webhook_policies_key_overlap_default_seconds_check" CHECK (("key_overlap_default_seconds" > 0)),
    CONSTRAINT "webhook_policies_lease_seconds_check" CHECK (("lease_seconds" > 0)),
    CONSTRAINT "webhook_policies_max_automatic_attempts_check" CHECK (("max_automatic_attempts" > 0)),
    CONSTRAINT "webhook_policies_max_manual_operations_check" CHECK (("max_manual_operations" > 0)),
    CONSTRAINT "webhook_policies_metadata_retention_seconds_check" CHECK (("metadata_retention_seconds" > 0)),
    CONSTRAINT "webhook_policies_minimum_failure_wait_seconds_check" CHECK (("minimum_failure_wait_seconds" > 0)),
    CONSTRAINT "webhook_policies_operation_future_skew_seconds_check" CHECK (("operation_future_skew_seconds" >= 0)),
    CONSTRAINT "webhook_policies_operation_max_age_seconds_check" CHECK (("operation_max_age_seconds" > 0)),
    CONSTRAINT "webhook_policies_operation_retention_seconds_check" CHECK (("operation_retention_seconds" > 0)),
    CONSTRAINT "webhook_policies_payload_retention_seconds_check" CHECK (("payload_retention_seconds" > 0)),
    CONSTRAINT "webhook_policies_version_check" CHECK (("version" > 0))
);

CREATE TABLE "webhook_signing_keys" (
    "id" "uuid" NOT NULL,
    "endpoint_id" "uuid" NOT NULL,
    "slot" "text" NOT NULL,
    "secret" "bytea" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "overlap_started_at" timestamp with time zone,
    "overlap_until" timestamp with time zone,
    CONSTRAINT "webhook_signing_keys_check" CHECK (((("slot" = 'current'::"text") AND ("overlap_started_at" IS NULL) AND ("overlap_until" IS NULL)) OR (("slot" = 'overlap'::"text") AND ("overlap_started_at" IS NOT NULL) AND ("overlap_until" IS NOT NULL) AND ("overlap_until" > "overlap_started_at") AND ("overlap_until" <= ("overlap_started_at" + '7 days'::interval))))),
    CONSTRAINT "webhook_signing_keys_created_at_check" CHECK ("isfinite"("created_at")),
    CONSTRAINT "webhook_signing_keys_overlap_started_at_check" CHECK ("isfinite"("overlap_started_at")),
    CONSTRAINT "webhook_signing_keys_overlap_until_check" CHECK ("isfinite"("overlap_until")),
    CONSTRAINT "webhook_signing_keys_secret_check" CHECK (("octet_length"("secret") = 32)),
    CONSTRAINT "webhook_signing_keys_slot_check" CHECK (("slot" = ANY (ARRAY['current'::"text", 'overlap'::"text"])))
);

CREATE TABLE "webhook_subscriptions" (
    "id" "uuid" NOT NULL,
    "endpoint_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "owner_kind" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "authorization_state" "text" NOT NULL,
    "authorization_epoch" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "webhook_subscriptions_authorization_epoch_check" CHECK (("authorization_epoch" > 0)),
    CONSTRAINT "webhook_subscriptions_authorization_state_check" CHECK (("authorization_state" = ANY (ARRAY['active'::"text", 'confirmation_required'::"text"]))),
    CONSTRAINT "webhook_subscriptions_created_at_check" CHECK ("isfinite"("created_at")),
    CONSTRAINT "webhook_subscriptions_deleted_at_check" CHECK ("isfinite"("deleted_at")),
    CONSTRAINT "webhook_subscriptions_owner_kind_check" CHECK (("owner_kind" = ANY (ARRAY['personal'::"text", 'team'::"text"]))),
    CONSTRAINT "webhook_subscriptions_updated_at_check" CHECK ("isfinite"("updated_at"))
);

CREATE TABLE "worker_prompts" (
    "user_id" "uuid" NOT NULL,
    "scope" "text" NOT NULL,
    "scope_id" "uuid" NOT NULL,
    "revision" bigint NOT NULL,
    "prompt_text" "text" NOT NULL,
    "updated_at" timestamp with time zone NOT NULL
);

CREATE TABLE "workers" (
    "user_id" "uuid" NOT NULL,
    "worker_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "last_seen_at" timestamp with time zone NOT NULL,
    "telemetry" "jsonb" NOT NULL,
    "task_snapshot" "jsonb" NOT NULL,
    "configuration_revision" bigint,
    "configuration_updated_at" timestamp with time zone,
    "desired_configuration" "jsonb",
    "configuration_observation_revision" bigint DEFAULT 0 NOT NULL,
    "configuration_observation" "jsonb",
    CONSTRAINT "worker_configuration_complete" CHECK (((("configuration_revision" IS NULL) AND ("configuration_updated_at" IS NULL) AND ("desired_configuration" IS NULL)) OR (("configuration_revision" IS NOT NULL) AND ("configuration_updated_at" IS NOT NULL) AND ("desired_configuration" IS NOT NULL) AND ("jsonb_typeof"("desired_configuration") = 'object'::"text")))),
    CONSTRAINT "worker_configuration_observation_object" CHECK ((("configuration_observation" IS NULL) OR ("jsonb_typeof"("configuration_observation") = 'object'::"text"))),
    CONSTRAINT "worker_configuration_observation_revision_nonnegative" CHECK (("configuration_observation_revision" >= 0)),
    CONSTRAINT "worker_configuration_revision_positive" CHECK (("configuration_revision" > 0)),
    CONSTRAINT "workers_task_snapshot_check" CHECK (("jsonb_typeof"("task_snapshot") = 'object'::"text")),
    CONSTRAINT "workers_telemetry_check" CHECK (("jsonb_typeof"("telemetry") = 'object'::"text"))
);

ALTER TABLE ONLY "assistant_task_appendix"
    ADD CONSTRAINT "assistant_task_appendix_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "assistant_task_claim_operations"
    ADD CONSTRAINT "assistant_task_claim_operations_pkey" PRIMARY KEY ("owner_user_id", "task_id", "operation_id");

ALTER TABLE ONLY "assistant_task_events"
    ADD CONSTRAINT "assistant_task_events_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "assistant_task_inquiries"
    ADD CONSTRAINT "assistant_task_inquiries_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "assistant_task_items"
    ADD CONSTRAINT "assistant_task_items_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "assistant_task_manual_versions"
    ADD CONSTRAINT "assistant_task_manual_versions_pkey" PRIMARY KEY ("task_id", "version");

ALTER TABLE ONLY "assistant_task_proposals"
    ADD CONSTRAINT "assistant_task_proposals_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "assistant_task_records"
    ADD CONSTRAINT "assistant_task_records_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "assistant_tasks"
    ADD CONSTRAINT "assistant_tasks_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "bot_configuration_preferences"
    ADD CONSTRAINT "bot_configuration_preferences_pkey" PRIMARY KEY ("user_id", "worker_id");

ALTER TABLE ONLY "bot_effort_preferences"
    ADD CONSTRAINT "bot_effort_preferences_pkey" PRIMARY KEY ("user_id", "worker_id", "provider", "model");

ALTER TABLE ONLY "bot_model_preferences"
    ADD CONSTRAINT "bot_model_preferences_pkey" PRIMARY KEY ("user_id", "worker_id", "provider");

ALTER TABLE ONLY "bot_worker_preferences"
    ADD CONSTRAINT "bot_worker_preferences_pkey" PRIMARY KEY ("user_id");

ALTER TABLE ONLY "bots"
    ADD CONSTRAINT "bots_creation_order_key" UNIQUE ("creation_order");

ALTER TABLE ONLY "bots"
    ADD CONSTRAINT "bots_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "bots"
    ADD CONSTRAINT "bots_session_id_key" UNIQUE ("session_id");

ALTER TABLE ONLY "bots"
    ADD CONSTRAINT "bots_session_owner" UNIQUE ("id", "owner_user_id");

ALTER TABLE ONLY "device_authorization_limits"
    ADD CONSTRAINT "device_authorization_limits_pkey" PRIMARY KEY ("bucket_hash");

ALTER TABLE ONLY "device_authorizations"
    ADD CONSTRAINT "device_authorizations_device_code_hash_key" UNIQUE ("device_code_hash");

ALTER TABLE ONLY "device_authorizations"
    ADD CONSTRAINT "device_authorizations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "device_authorizations"
    ADD CONSTRAINT "device_authorizations_user_code_key" UNIQUE ("user_code");

ALTER TABLE ONLY "login_transactions"
    ADD CONSTRAINT "login_transactions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "login_transactions"
    ADD CONSTRAINT "login_transactions_state_hash_key" UNIQUE ("state_hash");

ALTER TABLE ONLY "oauth_access_tokens"
    ADD CONSTRAINT "oauth_access_tokens_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "oauth_access_tokens"
    ADD CONSTRAINT "oauth_access_tokens_token_hash_key" UNIQUE ("token_hash");

ALTER TABLE ONLY "oauth_authorization_cleanup_cursor"
    ADD CONSTRAINT "oauth_authorization_cleanup_cursor_pkey" PRIMARY KEY ("singleton");

ALTER TABLE ONLY "oauth_authorizations"
    ADD CONSTRAINT "oauth_authorizations_code_hash_key" UNIQUE ("code_hash");

ALTER TABLE ONLY "oauth_authorizations"
    ADD CONSTRAINT "oauth_authorizations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "oauth_clients"
    ADD CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "oauth_credential_cleanup_cursor"
    ADD CONSTRAINT "oauth_credential_cleanup_cursor_pkey" PRIMARY KEY ("singleton");

ALTER TABLE ONLY "oauth_grants"
    ADD CONSTRAINT "oauth_grants_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "oauth_refresh_tokens"
    ADD CONSTRAINT "oauth_refresh_tokens_pkey" PRIMARY KEY ("token_hash");

ALTER TABLE ONLY "personal_access_tokens"
    ADD CONSTRAINT "personal_access_tokens_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "personal_access_tokens"
    ADD CONSTRAINT "personal_access_tokens_token_hash_key" UNIQUE ("token_hash");

ALTER TABLE ONLY "private_transfer_ledger"
    ADD CONSTRAINT "private_transfer_ledger_pkey" PRIMARY KEY ("singleton");

ALTER TABLE ONLY "private_transfers"
    ADD CONSTRAINT "private_transfers_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "private_upload_chunks"
    ADD CONSTRAINT "private_upload_chunks_pkey" PRIMARY KEY ("transfer_id", "chunk_id");

ALTER TABLE ONLY "private_upload_chunks"
    ADD CONSTRAINT "private_upload_chunks_transfer_id_byte_offset_key" UNIQUE ("transfer_id", "byte_offset");

ALTER TABLE ONLY "private_upload_chunks"
    ADD CONSTRAINT "private_upload_chunks_transfer_id_object_id_key" UNIQUE ("transfer_id", "object_id");

ALTER TABLE ONLY "project_github_pending_prs"
    ADD CONSTRAINT "project_github_pending_prs_pkey" PRIMARY KEY ("project_id", "number");

ALTER TABLE ONLY "project_github"
    ADD CONSTRAINT "project_github_pkey" PRIMARY KEY ("project_id");

ALTER TABLE ONLY "project_grants"
    ADD CONSTRAINT "project_grants_pkey" PRIMARY KEY ("project_id", "user_id");

ALTER TABLE ONLY "project_invitations"
    ADD CONSTRAINT "project_invitations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "project_invitations"
    ADD CONSTRAINT "project_invitations_token_hash_key" UNIQUE ("token_hash");

ALTER TABLE ONLY "project_ownership"
    ADD CONSTRAINT "project_ownership_pkey" PRIMARY KEY ("project_id");

ALTER TABLE ONLY "project_pull_requests"
    ADD CONSTRAINT "project_pull_requests_pkey" PRIMARY KEY ("project_id", "number");

ALTER TABLE ONLY "project_tags"
    ADD CONSTRAINT "project_tags_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "schema_migrations"
    ADD CONSTRAINT "schema_migrations_pkey" PRIMARY KEY ("version");

ALTER TABLE ONLY "session_archive_bundles"
    ADD CONSTRAINT "session_archive_bundles_pkey" PRIMARY KEY ("session_id");

ALTER TABLE ONLY "session_archive_bundles"
    ADD CONSTRAINT "session_archive_bundles_prepare_id_key" UNIQUE ("prepare_id");

ALTER TABLE ONLY "session_archive_chunks"
    ADD CONSTRAINT "session_archive_chunks_pkey" PRIMARY KEY ("session_id", "file_id", "chunk_offset");

ALTER TABLE ONLY "session_archive_files"
    ADD CONSTRAINT "session_archive_files_pkey" PRIMARY KEY ("session_id", "file_id");

ALTER TABLE ONLY "session_archive_migrations"
    ADD CONSTRAINT "session_archive_migrations_migration_id_key" UNIQUE ("migration_id");

ALTER TABLE ONLY "session_archive_migrations"
    ADD CONSTRAINT "session_archive_migrations_pkey" PRIMARY KEY ("session_id");

ALTER TABLE ONLY "session_archives"
    ADD CONSTRAINT "session_archives_pkey" PRIMARY KEY ("session_id");

ALTER TABLE ONLY "task_sessions"
    ADD CONSTRAINT "session_bot_identity" UNIQUE ("bot_id");

ALTER TABLE ONLY "session_events"
    ADD CONSTRAINT "session_events_pkey" PRIMARY KEY ("session_id", "event_seq");

ALTER TABLE ONLY "session_events"
    ADD CONSTRAINT "session_events_session_id_source_epoch_source_seq_key" UNIQUE ("session_id", "source_epoch", "source_seq");

ALTER TABLE ONLY "session_image_captures"
    ADD CONSTRAINT "session_image_captures_pkey" PRIMARY KEY ("session_id", "capture_id");

ALTER TABLE ONLY "session_image_captures"
    ADD CONSTRAINT "session_image_captures_session_id_image_id_key" UNIQUE ("session_id", "image_id");

ALTER TABLE ONLY "session_image_chunks"
    ADD CONSTRAINT "session_image_chunks_pkey" PRIMARY KEY ("session_id", "upload_id", "chunk_offset");

ALTER TABLE ONLY "session_image_uploads"
    ADD CONSTRAINT "session_image_uploads_pkey" PRIMARY KEY ("session_id", "upload_id");

ALTER TABLE ONLY "session_image_uploads"
    ADD CONSTRAINT "session_image_uploads_session_id_blob_id_key" UNIQUE ("session_id", "blob_id");

ALTER TABLE ONLY "session_media_rates"
    ADD CONSTRAINT "session_media_rates_pkey" PRIMARY KEY ("owner_user_id", "category");

ALTER TABLE ONLY "session_media_requests"
    ADD CONSTRAINT "session_media_requests_pkey" PRIMARY KEY ("session_id", "request_id");

ALTER TABLE ONLY "session_operation_intents"
    ADD CONSTRAINT "session_operation_intents_pkey" PRIMARY KEY ("session_id", "operation_id");

ALTER TABLE ONLY "session_operations"
    ADD CONSTRAINT "session_operations_pkey" PRIMARY KEY ("session_id", "operation_id");

ALTER TABLE ONLY "session_operations"
    ADD CONSTRAINT "session_operations_session_id_operation_seq_key" UNIQUE ("session_id", "operation_seq");

ALTER TABLE ONLY "session_recording_evidence"
    ADD CONSTRAINT "session_recording_evidence_pkey" PRIMARY KEY ("session_id", "execution_generation", "evidence_id");

ALTER TABLE ONLY "session_recording_evidence"
    ADD CONSTRAINT "session_recording_evidence_session_id_execution_generation__key" UNIQUE ("session_id", "execution_generation", "revision");

ALTER TABLE ONLY "session_resource_leases"
    ADD CONSTRAINT "session_resource_leases_pkey" PRIMARY KEY ("session_id", "lease_id");

ALTER TABLE ONLY "session_resource_references"
    ADD CONSTRAINT "session_resource_references_pkey" PRIMARY KEY ("session_id", "resource_id", "kind", "reference_id");

ALTER TABLE ONLY "session_resource_state"
    ADD CONSTRAINT "session_resource_state_pkey" PRIMARY KEY ("session_id");

ALTER TABLE ONLY "session_resources"
    ADD CONSTRAINT "session_resources_pkey" PRIMARY KEY ("session_id", "resource_id");

ALTER TABLE ONLY "session_source_hashes"
    ADD CONSTRAINT "session_source_hashes_pkey" PRIMARY KEY ("session_id", "source_epoch", "kind", "identity");

ALTER TABLE ONLY "session_timeline"
    ADD CONSTRAINT "session_timeline_pkey" PRIMARY KEY ("session_id", "entry_id");

ALTER TABLE ONLY "session_timeline"
    ADD CONSTRAINT "session_timeline_session_id_entry_seq_key" UNIQUE ("session_id", "entry_seq");

ALTER TABLE ONLY "sessions"
    ADD CONSTRAINT "sessions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "sessions"
    ADD CONSTRAINT "sessions_token_hash_key" UNIQUE ("token_hash");

ALTER TABLE ONLY "task_attachments"
    ADD CONSTRAINT "task_attachments_pkey" PRIMARY KEY ("task_id", "path");

ALTER TABLE ONLY "task_dependencies"
    ADD CONSTRAINT "task_dependencies_pkey" PRIMARY KEY ("project_id", "task_id", "depends_on_task_id");

ALTER TABLE ONLY "task_properties"
    ADD CONSTRAINT "task_properties_pkey" PRIMARY KEY ("task_id", "name");

ALTER TABLE ONLY "task_sessions"
    ADD CONSTRAINT "task_sessions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "task_sessions"
    ADD CONSTRAINT "task_sessions_project_id_registration_id_key" UNIQUE ("project_id", "registration_id");

ALTER TABLE ONLY "task_sessions"
    ADD CONSTRAINT "task_sessions_project_id_task_id_claim_id_key" UNIQUE ("project_id", "task_id", "claim_id");

ALTER TABLE ONLY "task_steps"
    ADD CONSTRAINT "task_steps_pkey" PRIMARY KEY ("task_id", "id");

ALTER TABLE ONLY "task_steps"
    ADD CONSTRAINT "task_steps_task_id_position_key" UNIQUE ("task_id", "position") DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE ONLY "task_tags"
    ADD CONSTRAINT "task_tags_pkey" PRIMARY KEY ("project_id", "task_id", "tag_id");

ALTER TABLE ONLY "task_thread_messages"
    ADD CONSTRAINT "task_thread_messages_pkey" PRIMARY KEY ("task_id", "message_id");

ALTER TABLE ONLY "task_threads"
    ADD CONSTRAINT "task_threads_pkey" PRIMARY KEY ("task_id");

ALTER TABLE ONLY "tasks"
    ADD CONSTRAINT "tasks_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "team_invitations"
    ADD CONSTRAINT "team_invitations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "team_invitations"
    ADD CONSTRAINT "team_invitations_token_hash_key" UNIQUE ("token_hash");

ALTER TABLE ONLY "team_members"
    ADD CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id", "user_id");

ALTER TABLE ONLY "teams"
    ADD CONSTRAINT "teams_personal_user_id_key" UNIQUE ("personal_user_id");

ALTER TABLE ONLY "teams"
    ADD CONSTRAINT "teams_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "users"
    ADD CONSTRAINT "users_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "users"
    ADD CONSTRAINT "users_uniauth_id_key" UNIQUE ("uniauth_id");

ALTER TABLE ONLY "webhook_attempts"
    ADD CONSTRAINT "webhook_attempts_delivery_id_lease_token_key" UNIQUE ("delivery_id", "lease_token");

ALTER TABLE ONLY "webhook_attempts"
    ADD CONSTRAINT "webhook_attempts_delivery_id_sequence_key" UNIQUE ("delivery_id", "sequence");

ALTER TABLE ONLY "webhook_attempts"
    ADD CONSTRAINT "webhook_attempts_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "webhook_bindings"
    ADD CONSTRAINT "webhook_bindings_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_event_id_endpoint_id_key" UNIQUE ("event_id", "endpoint_id");

ALTER TABLE ONLY "webhook_deliveries"
    ADD CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "webhook_delivery_matches"
    ADD CONSTRAINT "webhook_delivery_matches_delivery_id_binding_id_key" UNIQUE ("delivery_id", "binding_id");

ALTER TABLE ONLY "webhook_delivery_matches"
    ADD CONSTRAINT "webhook_delivery_matches_pkey" PRIMARY KEY ("delivery_id", "subscription_id", "binding_id");

ALTER TABLE ONLY "webhook_endpoint_waits"
    ADD CONSTRAINT "webhook_endpoint_waits_pkey" PRIMARY KEY ("endpoint_id", "destination_revision");

ALTER TABLE ONLY "webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "webhook_events"
    ADD CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "webhook_operations"
    ADD CONSTRAINT "webhook_operations_pkey" PRIMARY KEY ("owner_kind", "owner_id", "operation_id");

ALTER TABLE ONLY "webhook_policies"
    ADD CONSTRAINT "webhook_policies_pkey" PRIMARY KEY ("version");

ALTER TABLE ONLY "webhook_signing_keys"
    ADD CONSTRAINT "webhook_signing_keys_endpoint_id_slot_key" UNIQUE ("endpoint_id", "slot");

ALTER TABLE ONLY "webhook_signing_keys"
    ADD CONSTRAINT "webhook_signing_keys_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "webhook_subscriptions"
    ADD CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "worker_prompts"
    ADD CONSTRAINT "worker_prompts_pkey" PRIMARY KEY ("user_id", "scope", "scope_id");

ALTER TABLE ONLY "workers"
    ADD CONSTRAINT "workers_pkey" PRIMARY KEY ("user_id", "worker_id");

CREATE INDEX "assistant_task_appendix_page" ON "assistant_task_appendix" USING "btree" ("task_id", "created_at", "id");

CREATE INDEX "assistant_task_events_page" ON "assistant_task_events" USING "btree" ("task_id", "created_at", "id");

CREATE INDEX "assistant_task_events_target_state" ON "assistant_task_events" USING "btree" ("target_bot_id", "state");

CREATE INDEX "assistant_task_inquiries_page" ON "assistant_task_inquiries" USING "btree" ("task_id", "created_at", "id");

CREATE INDEX "assistant_task_inquiries_state_deadline" ON "assistant_task_inquiries" USING "btree" ("state", "deadline");

CREATE UNIQUE INDEX "assistant_task_items_open_key" ON "assistant_task_items" USING "btree" ("task_id", "key") WHERE ("state" = 'open'::"text");

CREATE INDEX "assistant_task_items_page" ON "assistant_task_items" USING "btree" ("task_id", "created_at", "id");

CREATE INDEX "assistant_task_proposals_page" ON "assistant_task_proposals" USING "btree" ("task_id", "created_at", "id");

CREATE INDEX "assistant_task_records_item_page" ON "assistant_task_records" USING "btree" ("task_id", "item_id", "created_at", "id");

CREATE INDEX "assistant_task_records_page" ON "assistant_task_records" USING "btree" ("task_id", "created_at", "id");

CREATE INDEX "assistant_tasks_holder" ON "assistant_tasks" USING "btree" ("holder_bot_id", "state");

CREATE UNIQUE INDEX "assistant_tasks_owner_application" ON "assistant_tasks" USING "btree" ("owner_user_id", "application") WHERE (("application" <> ''::"text") AND ("state" <> 'deleted'::"text"));

CREATE INDEX "assistant_tasks_owner_page" ON "assistant_tasks" USING "btree" ("owner_user_id", "created_at", "id");

CREATE INDEX "bots_owner_list" ON "bots" USING "btree" ("owner_user_id", "created_at", "id") WHERE ("deletion" IS NULL);

CREATE INDEX "bots_worker_list" ON "bots" USING "btree" ("owner_user_id", "worker_id", "created_at", "id");

CREATE INDEX "device_authorization_limits_expiry" ON "device_authorization_limits" USING "btree" ("expires_at");

CREATE INDEX "device_authorizations_expiry" ON "device_authorizations" USING "btree" ("expires_at");

CREATE INDEX "login_transactions_expiry" ON "login_transactions" USING "btree" ("expires_at");

CREATE INDEX "login_transactions_scope_expiry" ON "login_transactions" USING "btree" ("scope_hash", "expires_at");

CREATE INDEX "oauth_access_tokens_expiry" ON "oauth_access_tokens" USING "btree" ("expires_at");

CREATE INDEX "oauth_access_tokens_grant" ON "oauth_access_tokens" USING "btree" ("grant_id");

CREATE INDEX "oauth_authorizations_pending" ON "oauth_authorizations" USING "btree" ("expires_at") WHERE ("status" = 'pending'::"text");

CREATE INDEX "oauth_authorizations_retention" ON "oauth_authorizations" USING "btree" ("retain_until", "id");

CREATE INDEX "oauth_clients_expiry" ON "oauth_clients" USING "btree" ("expires_at", "id");

CREATE INDEX "oauth_grants_client_active" ON "oauth_grants" USING "btree" ("client_id", "expires_at") WHERE ("revoked_at" IS NULL);

CREATE INDEX "oauth_grants_expiry" ON "oauth_grants" USING "btree" ("expires_at");

CREATE INDEX "oauth_grants_owner" ON "oauth_grants" USING "btree" ("user_id", "created_at", "id");

CREATE INDEX "oauth_refresh_tokens_expiry" ON "oauth_refresh_tokens" USING "btree" ("expires_at");

CREATE INDEX "oauth_refresh_tokens_grant" ON "oauth_refresh_tokens" USING "btree" ("grant_id");

CREATE INDEX "personal_access_tokens_expiry" ON "personal_access_tokens" USING "btree" ("expires_at");

CREATE INDEX "personal_access_tokens_user" ON "personal_access_tokens" USING "btree" ("user_id", "created_at", "id");

CREATE INDEX "private_transfers_cleanup_pending" ON "private_transfers" USING "btree" ("created_at") WHERE ("state" = 'cleanup_pending'::"text");

CREATE INDEX "private_transfers_expiry" ON "private_transfers" USING "btree" ("expires_at") WHERE ("state" <> 'closed'::"text");

CREATE INDEX "private_transfers_owner_active" ON "private_transfers" USING "btree" ("user_id") WHERE ("state" <> 'closed'::"text");

CREATE INDEX "private_transfers_retention" ON "private_transfers" USING "btree" ("retain_until") WHERE ("state" = 'closed'::"text");

CREATE INDEX "project_github_access_due" ON "project_github" USING "btree" ("next_access_check_at", "project_id") WHERE ("enabled" AND "sync_enabled");

CREATE INDEX "project_github_binding" ON "project_github" USING "btree" ("app_id", "installation_id", "repository_id");

CREATE INDEX "project_github_pending_prs_due" ON "project_github_pending_prs" USING "btree" ("next_attempt_at", "project_id");

CREATE INDEX "project_github_poll_due" ON "project_github" USING "btree" ("next_poll_at", "project_id") WHERE ("enabled" AND "sync_enabled");

CREATE INDEX "project_grants_user" ON "project_grants" USING "btree" ("user_id", "project_id");

CREATE INDEX "project_invitations_expiry" ON "project_invitations" USING "btree" ("project_id", "expires_at");

CREATE INDEX "project_invitations_project" ON "project_invitations" USING "btree" ("project_id", "created_at", "id");

CREATE INDEX "project_ownership_team" ON "project_ownership" USING "btree" ("team_id", "project_id");

CREATE INDEX "project_pull_requests_state_number" ON "project_pull_requests" USING "btree" ("project_id", "state", "number" DESC);

CREATE UNIQUE INDEX "project_tags_project_name_key_idx" ON "project_tags" USING "btree" ("project_id", "name_key");

CREATE INDEX "projects_created_id" ON "projects" USING "btree" ("created_at", "id");

CREATE INDEX "projects_live_created_id_idx" ON "projects" USING "btree" ("created_at", "id") WHERE ("deleted_at" IS NULL);

CREATE UNIQUE INDEX "session_archive_one_receiving_file" ON "session_archive_files" USING "btree" ("session_id") WHERE ("state" = 'receiving'::"text");

CREATE UNIQUE INDEX "session_image_capture_attempt" ON "session_image_captures" USING "btree" ("session_id", (("receipt" ->> 'attemptId'::"text")));

CREATE UNIQUE INDEX "session_image_occurrence_source" ON "session_image_captures" USING "btree" ("session_id", ((("request" -> 'occurrence'::"text") ->> 'sourceKey'::"text")));

CREATE INDEX "session_operations_pending" ON "session_operations" USING "btree" ("session_id", "operation_seq") WHERE (("receipt" ->> 'state'::"text") = 'accepted'::"text");

CREATE INDEX "session_operations_terminal_pending" ON "session_operations" USING "btree" ("session_id", "operation_seq") WHERE (("receipt" ->> 'state'::"text") = ANY (ARRAY['queued'::"text", 'dispatching'::"text"]));

CREATE INDEX "session_resource_leases_owner" ON "session_resource_leases" USING "btree" ("owner_id", "kind");

CREATE INDEX "sessions_expiry" ON "sessions" USING "btree" ("expires_at");

CREATE INDEX "task_dependencies_predecessor" ON "task_dependencies" USING "btree" ("project_id", "depends_on_task_id", "task_id");

CREATE INDEX "task_session_history" ON "task_sessions" USING "btree" ("project_id", "task_id", "created_at" DESC, "id" DESC) WHERE ("scope" = 'task'::"text");

CREATE INDEX "task_sessions_project_id_id_task_idx" ON "task_sessions" USING "btree" ("project_id", "id") WHERE ("scope" = 'task'::"text");

CREATE INDEX "task_tags_project_tag_task_idx" ON "task_tags" USING "btree" ("project_id", "tag_id", "task_id");

CREATE INDEX "task_thread_messages_order" ON "task_thread_messages" USING "btree" ("task_id", "created_at", "message_id");

CREATE INDEX "tasks_personal_in_progress" ON "tasks" USING "btree" ("assigned_to", "project_id", "started_at" DESC NULLS LAST, "id") WHERE (("type" = 'task'::"text") AND ("status" = 'in_progress'::"text") AND ("deleted_at" IS NULL));

CREATE INDEX "tasks_project_assigned_to_created_id" ON "tasks" USING "btree" ("project_id", "assigned_to", "created_at", "id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "tasks_project_assigned_to_created_id_all" ON "tasks" USING "btree" ("project_id", "assigned_to", "created_at", "id");

CREATE INDEX "tasks_project_created_id" ON "tasks" USING "btree" ("project_id", "created_at", "id");

CREATE INDEX "tasks_project_id_id_idx" ON "tasks" USING "btree" ("project_id", "id");

CREATE INDEX "tasks_project_parent_created_id" ON "tasks" USING "btree" ("project_id", "parent_id", "created_at", "id");

CREATE INDEX "tasks_project_status_created_id" ON "tasks" USING "btree" ("project_id", "status", "created_at", "id");

CREATE INDEX "tasks_project_type_created_id" ON "tasks" USING "btree" ("project_id", "type", "created_at", "id");

CREATE INDEX "tasks_project_updated_id" ON "tasks" USING "btree" ("project_id", "updated_at", "id");

CREATE INDEX "team_invitations_expiry" ON "team_invitations" USING "btree" ("team_id", "expires_at");

CREATE INDEX "team_invitations_team" ON "team_invitations" USING "btree" ("team_id", "created_at", "id");

CREATE INDEX "team_members_team_created" ON "team_members" USING "btree" ("team_id", "created_at");

CREATE INDEX "team_members_user" ON "team_members" USING "btree" ("user_id", "team_id");

CREATE UNIQUE INDEX "test_session_execution" ON "task_sessions" USING "btree" ("owner_user_id", "test_execution_id") WHERE ("scope" = 'test'::"text");

CREATE UNIQUE INDEX "test_session_registration" ON "task_sessions" USING "btree" ("owner_user_id", "registration_id") WHERE ("scope" = 'test'::"text");

CREATE INDEX "webhook_attempts_history" ON "webhook_attempts" USING "btree" ("delivery_id", "generation", "sequence", "id");

CREATE UNIQUE INDEX "webhook_bindings_active" ON "webhook_bindings" USING "btree" ("subscription_id", "event_type") WHERE ("deleted_at" IS NULL);

CREATE INDEX "webhook_bindings_capture" ON "webhook_bindings" USING "btree" ("event_type", "subscription_id", "id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "webhook_bindings_deleted" ON "webhook_bindings" USING "btree" ("subscription_id", "deleted_at", "id") WHERE ("deleted_at" IS NOT NULL);

CREATE INDEX "webhook_deliveries_due" ON "webhook_deliveries" USING "btree" ("next_attempt_at", "queue_order", "id") WHERE (("state" = 'pending'::"text") AND ("purging_at" IS NULL));

CREATE INDEX "webhook_deliveries_endpoint_revision" ON "webhook_deliveries" USING "btree" ("endpoint_id", "destination_revision", "id");

CREATE INDEX "webhook_deliveries_event" ON "webhook_deliveries" USING "btree" ("event_id", "id");

CREATE INDEX "webhook_deliveries_fifo" ON "webhook_deliveries" USING "btree" ("queue_order", "id") WHERE (("state" = 'pending'::"text") AND ("purging_at" IS NULL));

CREATE INDEX "webhook_deliveries_history" ON "webhook_deliveries" USING "btree" ("owner_kind", "owner_id", "endpoint_id", "occurred_at" DESC, "id" DESC);

CREATE INDEX "webhook_deliveries_lease" ON "webhook_deliveries" USING "btree" ("lease_until", "id") WHERE ("lease_token" IS NOT NULL);

CREATE INDEX "webhook_deliveries_metadata_expiry" ON "webhook_deliveries" USING "btree" ("metadata_expires_at", "id");

CREATE INDEX "webhook_deliveries_purging" ON "webhook_deliveries" USING "btree" ("purging_at", "id") WHERE ("purging_at" IS NOT NULL);

CREATE INDEX "webhook_delivery_matches_binding" ON "webhook_delivery_matches" USING "btree" ("binding_id", "delivery_id");

CREATE INDEX "webhook_delivery_matches_subscription" ON "webhook_delivery_matches" USING "btree" ("subscription_id", "delivery_id");

CREATE INDEX "webhook_endpoint_waits_owner" ON "webhook_endpoint_waits" USING "btree" ("owner_kind", "owner_id", "endpoint_id", "destination_revision");

CREATE INDEX "webhook_endpoints_deleted" ON "webhook_endpoints" USING "btree" ("deleted_at", "id") WHERE ("deleted_at" IS NOT NULL);

CREATE INDEX "webhook_endpoints_owner" ON "webhook_endpoints" USING "btree" ("owner_kind", "owner_id", "created_at", "id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "webhook_events_occurred" ON "webhook_events" USING "btree" ("occurred_at", "id");

CREATE INDEX "webhook_operations_delivery" ON "webhook_operations" USING "btree" ("delivery_id", "expires_at", "operation_id") WHERE ("delivery_id" IS NOT NULL);

CREATE INDEX "webhook_operations_endpoint" ON "webhook_operations" USING "btree" ("endpoint_id", "expires_at", "operation_id");

CREATE INDEX "webhook_operations_expiry" ON "webhook_operations" USING "btree" ("expires_at", "owner_kind", "owner_id", "operation_id");

CREATE INDEX "webhook_signing_keys_overlap_expiry" ON "webhook_signing_keys" USING "btree" ("overlap_until", "endpoint_id", "id") WHERE ("slot" = 'overlap'::"text");

CREATE INDEX "webhook_subscriptions_acl" ON "webhook_subscriptions" USING "btree" ("project_id", "owner_kind", "owner_id", "id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "webhook_subscriptions_deleted" ON "webhook_subscriptions" USING "btree" ("endpoint_id", "deleted_at", "id") WHERE ("deleted_at" IS NOT NULL);

CREATE INDEX "webhook_subscriptions_endpoint" ON "webhook_subscriptions" USING "btree" ("endpoint_id", "id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "workers_recent" ON "workers" USING "btree" ("user_id", "last_seen_at" DESC, "worker_id");

CREATE TRIGGER "webhook_policy_no_update" BEFORE UPDATE ON "webhook_policies" FOR EACH ROW EXECUTE FUNCTION "webhook_policy_no_update"();

ALTER TABLE ONLY "bot_configuration_preferences"
    ADD CONSTRAINT "bot_configuration_preferences_user_id_worker_id_fkey" FOREIGN KEY ("user_id", "worker_id") REFERENCES "workers"("user_id", "worker_id");

ALTER TABLE ONLY "bot_effort_preferences"
    ADD CONSTRAINT "bot_effort_preferences_user_id_worker_id_fkey" FOREIGN KEY ("user_id", "worker_id") REFERENCES "workers"("user_id", "worker_id");

ALTER TABLE ONLY "bot_model_preferences"
    ADD CONSTRAINT "bot_model_preferences_user_id_worker_id_fkey" FOREIGN KEY ("user_id", "worker_id") REFERENCES "workers"("user_id", "worker_id");

ALTER TABLE ONLY "bot_worker_preferences"
    ADD CONSTRAINT "bot_worker_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");

ALTER TABLE ONLY "bot_worker_preferences"
    ADD CONSTRAINT "bot_worker_preferences_user_id_worker_id_fkey" FOREIGN KEY ("user_id", "worker_id") REFERENCES "workers"("user_id", "worker_id");

ALTER TABLE ONLY "bots"
    ADD CONSTRAINT "bots_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id");

ALTER TABLE ONLY "bots"
    ADD CONSTRAINT "bots_owner_user_id_worker_id_fkey" FOREIGN KEY ("owner_user_id", "worker_id") REFERENCES "workers"("user_id", "worker_id");

ALTER TABLE ONLY "private_upload_chunks"
    ADD CONSTRAINT "private_upload_chunks_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "private_transfers"("id") ON DELETE CASCADE;

ALTER TABLE ONLY "task_sessions"
    ADD CONSTRAINT "session_bot_owner" FOREIGN KEY ("bot_id", "owner_user_id") REFERENCES "bots"("id", "owner_user_id");

INSERT INTO "oauth_authorization_cleanup_cursor" ("singleton", "next_kind") VALUES (true, 0);

INSERT INTO "oauth_credential_cleanup_cursor" ("singleton", "next_kind") VALUES (true, 0);

INSERT INTO "private_transfer_ledger" ("singleton", "reserved_bytes", "outstanding_bytes") VALUES (true, 0, 0);

INSERT INTO "webhook_policies" ("version", "max_automatic_attempts", "automatic_window_seconds", "automatic_offsets_seconds", "max_manual_operations", "payload_retention_seconds", "metadata_retention_seconds", "operation_retention_seconds", "operation_max_age_seconds", "operation_future_skew_seconds", "http_timeout_seconds", "lease_seconds", "minimum_failure_wait_seconds", "jitter_basis_points", "jitter_max_seconds", "key_overlap_default_seconds", "key_overlap_max_seconds") VALUES (1, 10, 259200, '{0,60,300,1800,7200,21600,43200,86400,172800,255600}', 3, 604800, 2592000, 2592000, 300, 60, 15, 45, 5, 1000, 1800, 86400, 604800);

SELECT pg_catalog.setval('"bots_creation_order_seq"', 1, false);

SELECT pg_catalog.setval('"project_grant_versions"', 1, false);

SELECT pg_catalog.setval('"team_member_versions"', 1, false);

SELECT pg_catalog.setval('"webhook_delivery_queue_order_seq"', 1, false);
