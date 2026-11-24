package postgres

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func TestBrowserManagementMigrationPreservesLegacySessions(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 120 })
	if index < 2 || schemaMigrations[index-1].version != 119 || schemaMigrations[index-2].version != 118 {
		t.Fatal("browser management must follow activity and Step Webhook retirement migrations")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	project, err := testutil.CreateProject(ctx, pool, &Store{Pool: pool}, queryID(975), "Historical fixture", "https://example.test/fixture")
	if err != nil || project.ID != queryID(975) {
		t.Fatalf("schema 119 project fixture: %+v %v", project, err)
	}
	user, session := queryID(971), queryID(972)
	if _, err := pool.Exec(ctx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,'management-migration',now(),now())`, user); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO sessions(id,user_id,token_hash,preview_token_hash,created_at,last_used_at,expires_at) VALUES($1,$2,decode(repeat('01',32),'hex'),decode(repeat('02',32),'hex'),now()-interval '1 hour',now()-interval '5 minutes',now()+interval '1 hour')`, session, user); err != nil {
		t.Fatal(err)
	}
	var before, activityChecksum, retirementChecksum string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(s)::text,(SELECT checksum FROM schema_migrations WHERE version=118),(SELECT checksum FROM schema_migrations WHERE version=119) FROM sessions s WHERE id=$1`, session).Scan(&before, &activityChecksum, &retirementChecksum); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var after, checksum, retirementAfter string
	var unknown, indexes bool
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(s)-'browser'-'os')::text,browser IS NULL AND os IS NULL,(SELECT checksum FROM schema_migrations WHERE version=118),(SELECT checksum FROM schema_migrations WHERE version=119),to_regclass('sessions_user_created_id') IS NOT NULL AND to_regclass('sessions_expiry') IS NOT NULL AND to_regclass('sessions_preview_token_hash') IS NOT NULL AND to_regclass('sessions_token_hash_key') IS NOT NULL FROM sessions s WHERE id=$1`, session).Scan(&after, &unknown, &checksum, &retirementAfter, &indexes); err != nil {
		t.Fatal(err)
	}
	if before != after || !unknown || activityChecksum != checksum || retirementChecksum != retirementAfter || retirementAfter != schemaMigrations[index-1].checksum() || !indexes {
		t.Fatalf("legacy session changed: unknown=%v indexes=%v", unknown, indexes)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
}

func TestBrowserActivityMigrationPreservesPublishedMigrationsAndOldSession(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 118 })
	if index < 4 || schemaMigrations[index-4].version != 114 || schemaMigrations[index-4].sql != sessionHistoryPolicySQL || schemaMigrations[index-3].version != 115 || schemaMigrations[index-3].transformSource == "" || schemaMigrations[index-2].version != 116 || schemaMigrations[index-2].sql != archiveUploadVersionSQL || schemaMigrations[index-1].version != 117 || schemaMigrations[index-1].sql != sessionOnlineModeSQL {
		t.Fatal("browser activity must follow the published history policy, frozen worker index, archive upload and Session online mode migrations")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index-1]); err != nil {
		t.Fatal(err)
	}
	execution := queryID(943)
	if _, err := pool.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,'test',$2,$3,$4,'{}','{"lifecycle":"archived"}')`, execution, queryID(944), queryID(945), queryID(946)); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	var onlineBefore, onlineChecksumBefore string
	onlineFacts := `SELECT to_jsonb(s)::text,checksum FROM task_sessions s CROSS JOIN schema_migrations WHERE s.id=$1 AND version=117 AND s.online_mode='legacy'`
	if err := pool.QueryRow(ctx, onlineFacts, execution).Scan(&onlineBefore, &onlineChecksumBefore); err != nil {
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
	if indexAfter != indexBefore || checksumAfter != checksumBefore || checksumAfter != schemaMigrations[index-3].checksum() {
		t.Fatal("browser activity migration changed the published worker index or frozen checksum")
	}
	var archiveAfter, archiveChecksumAfter string
	if err := pool.QueryRow(ctx, archiveFacts).Scan(&archiveAfter, &archiveChecksumAfter); err != nil {
		t.Fatal(err)
	}
	if archiveAfter != archiveBefore || archiveChecksumAfter != archiveChecksumBefore || archiveChecksumAfter != schemaMigrations[index-2].checksum() {
		t.Fatal("browser activity migration changed the published archive schema or checksum")
	}
	var onlineAfter, onlineChecksumAfter string
	if err := pool.QueryRow(ctx, onlineFacts, execution).Scan(&onlineAfter, &onlineChecksumAfter); err != nil {
		t.Fatal(err)
	}
	if onlineAfter != onlineBefore || onlineChecksumAfter != onlineChecksumBefore || onlineChecksumAfter != schemaMigrations[index-1].checksum() {
		t.Fatal("browser activity migration changed the published online mode binding or checksum")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatalf("reopening the complete migration ledger: %v", err)
	}
}

func TestSessionHistoryPolicyMigration(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 114 })
	if index < 1 {
		t.Fatal("history policy migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	id := queryID(921)
	snapshot, err := json.Marshal(sp.Snapshot{SessionID: id, Lifecycle: "archived"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,'test',$2,$3,$4,'{}',$5)`, id, queryID(922), queryID(923), queryID(924), snapshot); err != nil {
		t.Fatal(err)
	}
	if err = migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	read := func(want *string) {
		t.Helper()
		var policy *string
		var raw []byte
		if err := pool.QueryRow(ctx, `SELECT history_content_policy, snapshot FROM task_sessions WHERE id=$1`, id).Scan(&policy, &raw); err != nil {
			t.Fatal(err)
		}
		if (policy == nil) != (want == nil) || want != nil && *policy != *want {
			t.Fatalf("policy readback: got=%v want=%v", policy, want)
		}
		var saved sp.Snapshot
		if err := json.Unmarshal(raw, &saved); err != nil || saved.SessionID != id || saved.Lifecycle != "archived" {
			t.Fatalf("migration changed original snapshot: %+v, %v", saved, err)
		}
	}
	read(nil)
	for _, policy := range []string{"legacy", "task_body"} {
		if _, err = pool.Exec(ctx, `UPDATE task_sessions SET history_content_policy=$2 WHERE id=$1`, id, policy); err != nil {
			t.Fatal(err)
		}
		read(&policy)
	}
	for _, policy := range []string{"", "unknown", "TASK_BODY"} {
		if _, err = pool.Exec(ctx, `UPDATE task_sessions SET history_content_policy=$2 WHERE id=$1`, id, policy); err == nil {
			t.Fatalf("migration accepted invalid policy %q", policy)
		}
	}
	want := "task_body"
	read(&want)
	// The current DAO must preserve the migrated execution's established policy.
	if err = migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dao := pgsession.New(tx)
	record, err := dao.LockSession(ctx, id)
	if err != nil || record.OnlineMode != "legacy" || record.HistoryContentPolicy == nil || *record.HistoryContentPolicy != want {
		t.Fatalf("current DAO: %+v %v", record, err)
	}
	replacement := "legacy"
	record.HistoryContentPolicy = &replacement
	if err = dao.SaveSession(ctx, record); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	read(&want)
}

func TestSessionOnlineModeMigrationAndPersistence(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 117 })
	if index < 1 {
		t.Fatal("online mode migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	oldID, newID, invalidID := queryID(925), queryID(926), queryID(927)
	insert := func(id string, offset int) {
		t.Helper()
		snapshot, err := json.Marshal(sp.Snapshot{SessionID: id, Lifecycle: "archived"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = pool.Exec(ctx, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,'test',$2,$3,$4,'{}',$5)`, id, queryID(offset), queryID(offset+1), queryID(offset+2), snapshot); err != nil {
			t.Fatal(err)
		}
	}
	insert(oldID, 930)
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	insert(newID, 933)
	insert(invalidID, 936)
	if _, err := pool.Exec(ctx, `UPDATE task_sessions SET online_mode='' WHERE id=$1`, invalidID); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	dao := pgsession.New(tx)
	if _, err := dao.LockSession(ctx, invalidID); err == nil {
		t.Fatal("empty persisted mode was treated as unbound")
	}
	old, err := dao.LockSession(ctx, oldID)
	if err != nil || old.OnlineMode != "legacy" || old.HistoryContentPolicy != nil || old.Snapshot.Lifecycle != "archived" {
		t.Fatalf("old = %+v, %v", old, err)
	}
	fresh, err := dao.LockSession(ctx, newID)
	if err != nil || fresh.OnlineMode != "" || fresh.HistoryContentPolicy != nil {
		t.Fatalf("new = %+v, %v", fresh, err)
	}
	policy := "task_body"
	fresh.OnlineMode, fresh.HistoryContentPolicy = "relay", &policy
	if err = dao.SaveSession(ctx, fresh); err != nil {
		t.Fatal(err)
	}
	// Existing executions retain their old policy even if a later save supplies
	// different values; new executions acquire both fields only once.
	oldPolicy := "legacy"
	old.OnlineMode, old.HistoryContentPolicy = "relay", &oldPolicy
	if err = dao.SaveSession(ctx, old); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	migrated, err := pgsession.New(tx).LockSession(ctx, oldID)
	if err != nil || migrated.OnlineMode != "legacy" || migrated.HistoryContentPolicy != nil {
		t.Fatalf("old save changed binding: %+v, %v", migrated, err)
	}
	saved, err := pgsession.New(tx).LockSession(ctx, newID)
	if err != nil || saved.OnlineMode != "relay" || saved.HistoryContentPolicy == nil || *saved.HistoryContentPolicy != policy {
		t.Fatalf("saved = %+v, %v", saved, err)
	}
	saved.OnlineMode, saved.HistoryContentPolicy = "legacy", &oldPolicy
	if err = pgsession.New(tx).SaveSession(ctx, saved); err != nil {
		t.Fatal(err)
	}
	again, err := pgsession.New(tx).LockSession(ctx, newID)
	if err != nil || again.OnlineMode != "relay" || again.HistoryContentPolicy == nil || *again.HistoryContentPolicy != policy {
		t.Fatalf("binding overwritten: %+v, %v", again, err)
	}
}

func TestArchiveRetentionKeepsLegacyPublicationUnknown(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := isolatedStore(t).Pool
	project, task := queryID(901), queryID(902)
	if _, err := pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'retention','https://example.test/retention');`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'historical','done')`, task, project); err != nil {
		t.Fatal(err)
	}
	ready := queryID(903)
	if _, err := pool.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$1,$1,$1,'{}','{}')`, ready, project, task); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,updated_at) VALUES($1,'ready',repeat('a',64),5,'old/path','2020-01-01')`, ready); err != nil {
		t.Fatal(err)
	}
	publication := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	grace := publication.Add(7 * 24 * time.Hour)
	if _, err := pool.Exec(ctx, `INSERT INTO session_archive_retention(session_id,grace_until) VALUES($1,$2)`, ready, grace); err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err := pgsession.New(tx).(store.SessionArchiveRetentionDAO).RecordSessionArchiveSuccess(ctx, ready, publication); err != nil {
		t.Fatal(err)
	}
	var retained bool
	if err := tx.QueryRow(ctx, `SELECT first_succeeded_at IS NULL AND grace_until=$2 AND version=1 FROM session_archive_retention WHERE session_id=$1`, ready, grace).Scan(&retained); err != nil || !retained {
		t.Fatalf("conversion refreshed legacy success: %v %v", retained, err)
	}
}
