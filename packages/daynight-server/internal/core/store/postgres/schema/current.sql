-- Schema snapshot version: 46

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
    CONSTRAINT "login_transactions_browser_binding_hash_check" CHECK (("octet_length"("browser_binding_hash") = 32)),
    CONSTRAINT "login_transactions_provider_check" CHECK (("provider" = ANY (ARRAY['microsoft'::"text", 'google'::"text", 'github'::"text"]))),
    CONSTRAINT "login_transactions_return_path_check" CHECK (("left"("return_path", 1) = '/'::"text")),
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
    CONSTRAINT "oauth_grants_check" CHECK ((("expires_at" > "created_at") AND ("expires_at" <= ("created_at" + '720:00:00'::interval)))),
    CONSTRAINT "oauth_grants_client_id_check" CHECK (("length"("client_id") > 0)),
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
    CONSTRAINT "session_archive_body" CHECK (((("state" = 'ready'::"text") AND ("sha256" ~ '^[a-f0-9]{64}$'::"text") AND ("sha256" IS NOT NULL) AND (("byte_length" >= 1) AND ("byte_length" <= 67108864)) AND ("byte_length" IS NOT NULL) AND ("object_path" IS NOT NULL) AND ("error_code" IS NULL)) OR (("state" <> 'ready'::"text") AND ("sha256" IS NULL) AND ("byte_length" IS NULL) AND ("object_path" IS NULL)))),
    CONSTRAINT "session_archive_state" CHECK (("state" = ANY (ARRAY['pending'::"text", 'ready'::"text", 'failed'::"text", 'unavailable'::"text"]))),
    CONSTRAINT "session_archive_version" CHECK (((("schema_version" = 1) AND ("state" <> 'unavailable'::"text") AND (("state" <> 'pending'::"text") OR ("error_code" IS NULL)) AND ("completeness" IS NULL) AND ("finalization_id" IS NULL) AND ("receipt" IS NULL)) OR (("schema_version" = 2) AND ((("state" = 'ready'::"text") AND ("completeness" = ANY (ARRAY['complete'::"text", 'partial'::"text"])) AND ("finalization_id" IS NOT NULL) AND ("receipt" IS NOT NULL)) OR (("state" = 'unavailable'::"text") AND ("completeness" IS NULL) AND ("finalization_id" IS NOT NULL) AND ("receipt" IS NOT NULL)) OR (("state" = ANY (ARRAY['pending'::"text", 'failed'::"text"])) AND ("completeness" IS NULL) AND ("receipt" IS NULL)))))),
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

CREATE TABLE "session_resources" (
    "session_id" "uuid" NOT NULL,
    "resource_id" "uuid" NOT NULL,
    "descriptor" "jsonb" NOT NULL,
    "content" "bytea",
    CONSTRAINT "session_resources_content_check" CHECK ((("content" IS NULL) OR ("octet_length"("content") <= 8388608)))
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

CREATE TABLE "tasks" (
    "id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text" DEFAULT ''::"text" NOT NULL,
    "status" "text" DEFAULT 'todo'::"text" NOT NULL,
    "version" bigint DEFAULT 1 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "statement_timestamp"() NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "allow_agents" boolean DEFAULT false NOT NULL,
    "required_platform" "text",
    "deleted_at" timestamp with time zone,
    "assigned_to" "uuid",
    CONSTRAINT "tasks_required_platform_check" CHECK (("required_platform" = ANY (ARRAY['windows'::"text", 'linux'::"text", 'macos'::"text"]))),
    CONSTRAINT "tasks_status_check" CHECK (("status" = ANY (ARRAY['todo'::"text", 'in_progress'::"text", 'done'::"text"]))),
    CONSTRAINT "tasks_title_check" CHECK (("btrim"("title") <> ''::"text")),
    CONSTRAINT "tasks_version_check" CHECK (("version" > 0))
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

CREATE TABLE "webhook_bindings" (
    "id" "uuid" NOT NULL,
    "subscription_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "webhook_bindings_event_type_check" CHECK (("event_type" = ANY (ARRAY['task.created'::"text", 'task.status_changed'::"text", 'task.paused'::"text", 'task.deleted'::"text", 'task.step_updated'::"text", 'task.thread_posted'::"text"])))
);

CREATE TABLE "webhook_endpoints" (
    "id" "uuid" NOT NULL,
    "owner_kind" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "enabled" boolean NOT NULL,
    "config_version" bigint NOT NULL,
    "destination_revision" bigint NOT NULL,
    "destination_kind" "text" NOT NULL,
    "adapter_version" bigint NOT NULL,
    "destination_origin" "text" NOT NULL,
    "encrypted_destination" "bytea" NOT NULL,
    "active_key_id" "uuid",
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "webhook_endpoints_adapter_version_check" CHECK (("adapter_version" > 0)),
    CONSTRAINT "webhook_endpoints_check" CHECK ((("deleted_at" IS NOT NULL) OR (("char_length"("name") >= 1) AND ("char_length"("name") <= 120)))),
    CONSTRAINT "webhook_endpoints_config_version_check" CHECK (("config_version" > 0)),
    CONSTRAINT "webhook_endpoints_destination_revision_check" CHECK (("destination_revision" > 0)),
    CONSTRAINT "webhook_endpoints_owner_kind_check" CHECK (("owner_kind" = ANY (ARRAY['personal'::"text", 'team'::"text"])))
);

CREATE TABLE "webhook_operations" (
    "owner_kind" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "operation_id" "uuid" NOT NULL,
    "actor_user_id" "uuid" NOT NULL,
    "kind" "text" NOT NULL,
    "issued_at" "text" NOT NULL,
    "request_sha256" "text" NOT NULL,
    "fingerprint" "bytea" NOT NULL,
    "endpoint_id" "uuid" NOT NULL,
    "effect" "text" NOT NULL,
    "config_version_after" bigint NOT NULL,
    "destination_revision_after" bigint NOT NULL,
    "delivery_id" "uuid",
    "generation_after" bigint,
    "key_id" "uuid",
    "signing_overlap_until" timestamp with time zone,
    "recorded_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    CONSTRAINT "webhook_operations_check" CHECK (("expires_at" > "recorded_at")),
    CONSTRAINT "webhook_operations_config_version_after_check" CHECK (("config_version_after" > 0)),
    CONSTRAINT "webhook_operations_destination_revision_after_check" CHECK (("destination_revision_after" > 0)),
    CONSTRAINT "webhook_operations_effect_check" CHECK (("effect" = ANY (ARRAY['applied'::"text", 'unchanged'::"text"]))),
    CONSTRAINT "webhook_operations_fingerprint_check" CHECK (("octet_length"("fingerprint") = 32)),
    CONSTRAINT "webhook_operations_owner_kind_check" CHECK (("owner_kind" = ANY (ARRAY['personal'::"text", 'team'::"text"]))),
    CONSTRAINT "webhook_operations_request_sha256_check" CHECK (("request_sha256" ~ '^[0-9a-f]{64}$'::"text"))
);

CREATE TABLE "webhook_policies" (
    "version" bigint NOT NULL,
    "parameters" "bytea" NOT NULL,
    "sha256" "bytea" NOT NULL,
    CONSTRAINT "webhook_policies_sha256_check" CHECK (("octet_length"("sha256") = 32)),
    CONSTRAINT "webhook_policies_version_check" CHECK (("version" > 0))
);

CREATE TABLE "webhook_quota_buckets" (
    "bucket" smallint NOT NULL,
    "records_used" bigint DEFAULT 0 NOT NULL,
    "bytes_used" bigint DEFAULT 0 NOT NULL,
    "active_records_used" bigint DEFAULT 0 NOT NULL,
    "active_bytes_used" bigint DEFAULT 0 NOT NULL,
    "operations_used" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "webhook_quota_buckets_active_bytes_used_check" CHECK (("active_bytes_used" >= 0)),
    CONSTRAINT "webhook_quota_buckets_active_records_used_check" CHECK (("active_records_used" >= 0)),
    CONSTRAINT "webhook_quota_buckets_bucket_check" CHECK ((("bucket" >= 0) AND ("bucket" <= 15))),
    CONSTRAINT "webhook_quota_buckets_bytes_used_check" CHECK (("bytes_used" >= 0)),
    CONSTRAINT "webhook_quota_buckets_operations_used_check" CHECK (("operations_used" >= 0)),
    CONSTRAINT "webhook_quota_buckets_records_used_check" CHECK (("records_used" >= 0))
);

CREATE TABLE "webhook_quota_owners" (
    "owner_kind" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "bucket" smallint NOT NULL,
    "records_used" bigint DEFAULT 0 NOT NULL,
    "bytes_used" bigint DEFAULT 0 NOT NULL,
    "active_records_used" bigint DEFAULT 0 NOT NULL,
    "active_bytes_used" bigint DEFAULT 0 NOT NULL,
    "operations_used" bigint DEFAULT 0 NOT NULL,
    CONSTRAINT "webhook_quota_owners_active_bytes_used_check" CHECK (("active_bytes_used" >= 0)),
    CONSTRAINT "webhook_quota_owners_active_records_used_check" CHECK (("active_records_used" >= 0)),
    CONSTRAINT "webhook_quota_owners_bucket_check" CHECK ((("bucket" >= 0) AND ("bucket" <= 15))),
    CONSTRAINT "webhook_quota_owners_bytes_used_check" CHECK (("bytes_used" >= 0)),
    CONSTRAINT "webhook_quota_owners_operations_used_check" CHECK (("operations_used" >= 0)),
    CONSTRAINT "webhook_quota_owners_owner_kind_check" CHECK (("owner_kind" = ANY (ARRAY['personal'::"text", 'team'::"text"]))),
    CONSTRAINT "webhook_quota_owners_records_used_check" CHECK (("records_used" >= 0))
);

CREATE TABLE "webhook_signing_keys" (
    "id" "uuid" NOT NULL,
    "endpoint_id" "uuid" NOT NULL,
    "encrypted_secret" "bytea" NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "expires_at" timestamp with time zone,
    "revoked_at" timestamp with time zone
);

CREATE TABLE "webhook_subscriptions" (
    "id" "uuid" NOT NULL,
    "endpoint_id" "uuid" NOT NULL,
    "owner_kind" "text" NOT NULL,
    "owner_id" "uuid" NOT NULL,
    "project_id" "uuid" NOT NULL,
    "authorization_state" "text" NOT NULL,
    "authorization_epoch" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL,
    "deleted_at" timestamp with time zone,
    CONSTRAINT "webhook_subscriptions_authorization_epoch_check" CHECK (("authorization_epoch" > 0)),
    CONSTRAINT "webhook_subscriptions_authorization_state_check" CHECK (("authorization_state" = ANY (ARRAY['active'::"text", 'confirmation_required'::"text"]))),
    CONSTRAINT "webhook_subscriptions_owner_kind_check" CHECK (("owner_kind" = ANY (ARRAY['personal'::"text", 'team'::"text"])))
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

ALTER TABLE ONLY "project_grants"
    ADD CONSTRAINT "project_grants_pkey" PRIMARY KEY ("project_id", "user_id");

ALTER TABLE ONLY "project_invitations"
    ADD CONSTRAINT "project_invitations_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "project_invitations"
    ADD CONSTRAINT "project_invitations_token_hash_key" UNIQUE ("token_hash");

ALTER TABLE ONLY "project_ownership"
    ADD CONSTRAINT "project_ownership_pkey" PRIMARY KEY ("project_id");

ALTER TABLE ONLY "projects"
    ADD CONSTRAINT "projects_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "schema_migrations"
    ADD CONSTRAINT "schema_migrations_pkey" PRIMARY KEY ("version");

ALTER TABLE ONLY "session_archives"
    ADD CONSTRAINT "session_archives_pkey" PRIMARY KEY ("session_id");

ALTER TABLE ONLY "task_sessions"
    ADD CONSTRAINT "session_bot_identity" UNIQUE ("bot_id");

ALTER TABLE ONLY "session_events"
    ADD CONSTRAINT "session_events_pkey" PRIMARY KEY ("session_id", "event_seq");

ALTER TABLE ONLY "session_events"
    ADD CONSTRAINT "session_events_session_id_source_epoch_source_seq_key" UNIQUE ("session_id", "source_epoch", "source_seq");

ALTER TABLE ONLY "session_operations"
    ADD CONSTRAINT "session_operations_pkey" PRIMARY KEY ("session_id", "operation_id");

ALTER TABLE ONLY "session_operations"
    ADD CONSTRAINT "session_operations_session_id_operation_seq_key" UNIQUE ("session_id", "operation_seq");

ALTER TABLE ONLY "session_recording_evidence"
    ADD CONSTRAINT "session_recording_evidence_pkey" PRIMARY KEY ("session_id", "execution_generation", "evidence_id");

ALTER TABLE ONLY "session_recording_evidence"
    ADD CONSTRAINT "session_recording_evidence_session_id_execution_generation__key" UNIQUE ("session_id", "execution_generation", "revision");

ALTER TABLE ONLY "session_resources"
    ADD CONSTRAINT "session_resources_pkey" PRIMARY KEY ("session_id", "resource_id");

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

ALTER TABLE ONLY "webhook_bindings"
    ADD CONSTRAINT "webhook_bindings_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "webhook_endpoints"
    ADD CONSTRAINT "webhook_endpoints_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "webhook_operations"
    ADD CONSTRAINT "webhook_operations_pkey" PRIMARY KEY ("owner_kind", "owner_id", "operation_id");

ALTER TABLE ONLY "webhook_policies"
    ADD CONSTRAINT "webhook_policies_pkey" PRIMARY KEY ("version");

ALTER TABLE ONLY "webhook_quota_buckets"
    ADD CONSTRAINT "webhook_quota_buckets_pkey" PRIMARY KEY ("bucket");

ALTER TABLE ONLY "webhook_quota_owners"
    ADD CONSTRAINT "webhook_quota_owners_pkey" PRIMARY KEY ("owner_kind", "owner_id");

ALTER TABLE ONLY "webhook_signing_keys"
    ADD CONSTRAINT "webhook_signing_keys_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "webhook_subscriptions"
    ADD CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id");

ALTER TABLE ONLY "workers"
    ADD CONSTRAINT "workers_pkey" PRIMARY KEY ("user_id", "worker_id");

CREATE INDEX "bots_owner_list" ON "bots" USING "btree" ("owner_user_id", "created_at", "id") WHERE ("deletion" IS NULL);

CREATE INDEX "bots_worker_list" ON "bots" USING "btree" ("owner_user_id", "worker_id", "created_at", "id");

CREATE INDEX "device_authorization_limits_expiry" ON "device_authorization_limits" USING "btree" ("expires_at");

CREATE INDEX "device_authorizations_expiry" ON "device_authorizations" USING "btree" ("expires_at");

CREATE INDEX "login_transactions_expiry" ON "login_transactions" USING "btree" ("expires_at");

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

CREATE INDEX "project_grants_user" ON "project_grants" USING "btree" ("user_id", "project_id");

CREATE INDEX "project_invitations_expiry" ON "project_invitations" USING "btree" ("project_id", "expires_at");

CREATE INDEX "project_invitations_project" ON "project_invitations" USING "btree" ("project_id", "created_at", "id");

CREATE INDEX "project_ownership_team" ON "project_ownership" USING "btree" ("team_id", "project_id");

CREATE INDEX "projects_created_id" ON "projects" USING "btree" ("created_at", "id");

CREATE INDEX "projects_live_created_id_idx" ON "projects" USING "btree" ("created_at", "id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "session_operations_pending" ON "session_operations" USING "btree" ("session_id", "operation_seq") WHERE (("receipt" ->> 'state'::"text") = 'accepted'::"text");

CREATE INDEX "sessions_expiry" ON "sessions" USING "btree" ("expires_at");

CREATE INDEX "task_dependencies_predecessor" ON "task_dependencies" USING "btree" ("project_id", "depends_on_task_id", "task_id");

CREATE INDEX "task_session_history" ON "task_sessions" USING "btree" ("project_id", "task_id", "created_at" DESC, "id" DESC) WHERE ("scope" = 'task'::"text");

CREATE INDEX "task_sessions_project_id_id_task_idx" ON "task_sessions" USING "btree" ("project_id", "id") WHERE ("scope" = 'task'::"text");

CREATE INDEX "task_thread_messages_order" ON "task_thread_messages" USING "btree" ("task_id", "created_at", "message_id");

CREATE INDEX "tasks_project_assigned_to_created_id" ON "tasks" USING "btree" ("project_id", "assigned_to", "created_at", "id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "tasks_project_created_id" ON "tasks" USING "btree" ("project_id", "created_at", "id");

CREATE INDEX "tasks_project_id_id_idx" ON "tasks" USING "btree" ("project_id", "id");

CREATE INDEX "tasks_project_status_created_id" ON "tasks" USING "btree" ("project_id", "status", "created_at", "id");

CREATE INDEX "tasks_project_updated_id" ON "tasks" USING "btree" ("project_id", "updated_at", "id");

CREATE INDEX "team_invitations_expiry" ON "team_invitations" USING "btree" ("team_id", "expires_at");

CREATE INDEX "team_invitations_team" ON "team_invitations" USING "btree" ("team_id", "created_at", "id");

CREATE INDEX "team_members_user" ON "team_members" USING "btree" ("user_id", "team_id");

CREATE UNIQUE INDEX "test_session_execution" ON "task_sessions" USING "btree" ("owner_user_id", "test_execution_id") WHERE ("scope" = 'test'::"text");

CREATE UNIQUE INDEX "test_session_registration" ON "task_sessions" USING "btree" ("owner_user_id", "registration_id") WHERE ("scope" = 'test'::"text");

CREATE UNIQUE INDEX "webhook_bindings_active_selection" ON "webhook_bindings" USING "btree" ("subscription_id", "event_type") WHERE ("deleted_at" IS NULL);

CREATE INDEX "webhook_bindings_subscription" ON "webhook_bindings" USING "btree" ("subscription_id", "id");

CREATE INDEX "webhook_endpoints_owner_list" ON "webhook_endpoints" USING "btree" ("owner_kind", "owner_id", "created_at", "id");

CREATE INDEX "webhook_operations_expiry" ON "webhook_operations" USING "btree" ("expires_at", "owner_kind", "owner_id", "operation_id");

CREATE UNIQUE INDEX "webhook_signing_keys_active" ON "webhook_signing_keys" USING "btree" ("endpoint_id") WHERE (("revoked_at" IS NULL) AND ("expires_at" IS NULL));

CREATE INDEX "webhook_signing_keys_endpoint" ON "webhook_signing_keys" USING "btree" ("endpoint_id", "id");

CREATE INDEX "webhook_subscriptions_endpoint" ON "webhook_subscriptions" USING "btree" ("endpoint_id", "id");

CREATE INDEX "webhook_subscriptions_project_owner" ON "webhook_subscriptions" USING "btree" ("project_id", "owner_kind", "owner_id", "authorization_state", "id") WHERE ("deleted_at" IS NULL);

CREATE INDEX "workers_recent" ON "workers" USING "btree" ("user_id", "last_seen_at" DESC, "worker_id");

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

INSERT INTO "webhook_policies" ("version", "parameters", "sha256") VALUES (1, '\x7b2276657273696f6e223a312c22656e64706f696e744c696d6974223a32302c22737562736372697074696f6e73506572456e64706f696e74223a35302c2262696e64696e6773506572537562736372697074696f6e223a362c226d617463686564456e64706f696e747350657250726f6a656374223a3235362c2273746f726167654275636b657473223a31362c226275636b65745265636f72644c696d6974223a36353533362c226275636b657442797465734c696d6974223a3236383433353435362c226275636b65744163746976655265636f72644c696d6974223a33323736382c226275636b657441637469766542797465734c696d6974223a3133343231373732382c226f776e65725265636f72644c696d6974223a33323736382c226f776e657242797465734c696d6974223a36373130383836342c226f776e65724163746976655265636f72644c696d6974223a32343537362c226f776e657241637469766542797465734c696d6974223a35303333313634382c226f7065726174696f6e4f776e65724c696d6974223a313032342c226f7065726174696f6e4275636b65744c696d6974223a383139322c226f7065726174696f6e4279746573223a343039362c226f7065726174696f6e526574656e74696f6e5365636f6e6473223a323539323030302c226f7065726174696f6e4d61784167655365636f6e6473223a3330302c226f7065726174696f6e467574757265536b65775365636f6e6473223a36302c22636f6e66696775726174696f6e5265717565737442797465734c696d6974223a3236323134342c226175746f6d61746963417474656d70744c696d6974223a31302c226175746f6d6174696357696e646f775365636f6e6473223a3235393230302c226175746f6d617469634f6666736574735365636f6e6473223a5b302c36302c3330302c313830302c373230302c32313630302c34333230302c38363430302c3137323830302c3235353630305d2c2272657472794d696e696d756d576169745365636f6e6473223a352c2272657472794a697474657250657263656e74223a31302c2272657472794a69747465724d6178696d756d5365636f6e6473223a313830302c226d616e75616c417474656d70744c696d6974223a332c227061796c6f616457696e646f775365636f6e6473223a3630343830302c226d65746164617461526574656e74696f6e5365636f6e6473223a323539323030302c22676c6f62616c4c656173654c696d6974223a33322c226f776e65724c656173654c696d6974223a342c22656e64706f696e744c656173654c696d6974223a312c22776f726b65727350657250726f63657373223a382c226874747054696d656f75745365636f6e6473223a31352c226c656173655365636f6e6473223a34352c2264624f7065726174696f6e5365636f6e6473223a332c226f776e657241637469766551756575654c696d6974223a313032342c22656e64706f696e7441637469766551756575654c696d6974223a3235362c226275636b657441637469766551756575654c696d6974223a343039362c227369676e696e674f7665726c61705365636f6e6473223a38363430302c227369676e696e674d6178696d756d4f7665726c61705365636f6e6473223a3630343830302c227369676e696e674b65794c696d6974223a322c22676342617463684c696d6974223a3530302c226763576f726b5365636f6e6473223a322c2267634275737944656c61795365636f6e6473223a312c22676349646c6544656c61795365636f6e6473223a36302c22636f6e6e65637454696d656f75745365636f6e6473223a352c22746c7348616e647368616b655365636f6e6473223a352c22726573706f6e73654865616465725365636f6e6473223a31302c2268747470426f647942797465734c696d6974223a36353533362c2268747470526573706f6e736548656164657242797465734c696d6974223a31363338342c2268747470436c617373696669636174696f6e42797465734c696d6974223a323034382c22706572736973746564526573706f6e736542797465734c696d6974223a302c226576656e7442617463684c696d6974223a322c226576656e7442797465734c696d6974223a36353533362c227265636f7264456e76656c6f70654279746573223a323034382c2264656c697665727952657365727665645265636f726473223a36332c226e616d65436861726163746572734c696d6974223a3132302c227175657279436861726163746572734c696d6974223a3230302c226c69737444656661756c744c696d6974223a35302c226c6973744d6178696d756d4c696d6974223a3130302c2275726c42797465734c696d6974223a343039367d', '\x06f151ec945f69c5822e00440f004768f2123eb1ebd6244fa4995337124a5625');

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (0, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (1, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (2, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (3, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (4, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (5, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (6, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (7, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (8, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (9, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (10, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (11, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (12, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (13, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (14, 0, 0, 0, 0, 0);

INSERT INTO "webhook_quota_buckets" ("bucket", "records_used", "bytes_used", "active_records_used", "active_bytes_used", "operations_used") VALUES (15, 0, 0, 0, 0, 0);

SELECT pg_catalog.setval('"bots_creation_order_seq"', 1, false);

SELECT pg_catalog.setval('"project_grant_versions"', 1, false);

SELECT pg_catalog.setval('"team_member_versions"', 1, false);
