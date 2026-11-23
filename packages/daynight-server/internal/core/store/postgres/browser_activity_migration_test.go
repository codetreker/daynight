package postgres

import (
	"context"
	"slices"
	"testing"
	"time"
)

func TestBrowserActivityMigrationPreservesPublishedMigrationsAndOldSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 117 })
	if index < 3 || schemaMigrations[index-3].version != 114 || schemaMigrations[index-3].sql != sessionHistoryPolicySQL || schemaMigrations[index-2].version != 115 || schemaMigrations[index-2].transformSource == "" || schemaMigrations[index-1].version != 116 || schemaMigrations[index-1].sql != archiveUploadVersionSQL {
		t.Fatal("browser activity must follow the published history policy, frozen worker index and archive upload migrations")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	var indexBefore, checksumBefore string
	if err := pool.QueryRow(ctx, `SELECT pg_get_indexdef('task_properties_worker_active_claim_idx'::regclass),checksum FROM schema_migrations WHERE version=115`).Scan(&indexBefore, &checksumBefore); err != nil {
		t.Fatal(err)
	}
	var archiveBefore, archiveChecksumBefore string
	archiveFacts := `SELECT (SELECT jsonb_agg(jsonb_build_array(column_name,data_type,is_nullable,column_default) ORDER BY ordinal_position)::text FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='session_archive_files'),checksum FROM schema_migrations WHERE version=116`
	if err := pool.QueryRow(ctx, archiveFacts).Scan(&archiveBefore, &archiveChecksumBefore); err != nil {
		t.Fatal(err)
	}
	user, session := queryID(941), queryID(942)
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,'browser-migration',now(),now());`, user); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,decode(repeat('01',32),'hex'),clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 hour')`, session, user); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(s)::text FROM sessions s WHERE id=$1`, session).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var after string
	var unknownActivity, historyPolicy bool
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(s)-'last_used_at')::text,last_used_at IS NULL,EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='task_sessions' AND column_name='history_content_policy') FROM sessions s WHERE id=$1`, session).Scan(&after, &unknownActivity, &historyPolicy); err != nil {
		t.Fatal(err)
	}
	if after != before || !unknownActivity || !historyPolicy {
		t.Fatal("browser activity migration changed old session facts or removed history policy")
	}
	var indexAfter, checksumAfter string
	if err := pool.QueryRow(ctx, `SELECT pg_get_indexdef('task_properties_worker_active_claim_idx'::regclass),checksum FROM schema_migrations WHERE version=115`).Scan(&indexAfter, &checksumAfter); err != nil {
		t.Fatal(err)
	}
	if indexAfter != indexBefore || checksumAfter != checksumBefore || checksumAfter != schemaMigrations[index-2].checksum() {
		t.Fatal("browser activity migration changed the published worker index or frozen checksum")
	}
	var archiveAfter, archiveChecksumAfter string
	if err := pool.QueryRow(ctx, archiveFacts).Scan(&archiveAfter, &archiveChecksumAfter); err != nil {
		t.Fatal(err)
	}
	if archiveAfter != archiveBefore || archiveChecksumAfter != archiveChecksumBefore || archiveChecksumAfter != schemaMigrations[index-1].checksum() {
		t.Fatal("browser activity migration changed the published archive schema or checksum")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatalf("reopening the complete migration ledger: %v", err)
	}
}
