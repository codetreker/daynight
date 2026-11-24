package postgres

import (
	"slices"
	"testing"
)

func TestDropTaskStepsMigrationRollbackAndUpgrade(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 124 })
	if index < 1 {
		t.Fatal("migration 124 missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	_, err := pool.Exec(ctx, `
INSERT INTO projects(id,name,repo_url) VALUES('00000000-0000-0000-0000-000000000001','Migration','example');
INSERT INTO tasks(id,project_id,title,version,updated_at,deleted_at) VALUES
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Active',9007199254740993,'2026-01-02',NULL),
 ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Deleted',7,'2026-01-03','2026-01-04');
INSERT INTO task_steps(task_id,id,position,title,description,status,created_at,updated_at) VALUES
 ('00000000-0000-0000-0000-000000000002','00000001',0,'Active step','','done',now(),now()),
 ('00000000-0000-0000-0000-000000000003','00000002',0,'Deleted step','','todo',now(),now());
INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES
 ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','result.txt','text/plain',0);
INSERT INTO task_thread_messages(task_id,created_at,author_user_id,author_agent,body) VALUES
 ('00000000-0000-0000-0000-000000000002',now(),'00000000-0000-0000-0000-000000000004',false,'retained');`)
	if err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		t.Helper()
		var state string
		err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),
 'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY path) FROM task_attachments a),
 'thread',(SELECT jsonb_agg(to_jsonb(m) ORDER BY message_id) FROM task_thread_messages m))::text`).Scan(&state)
		if err != nil {
			t.Fatal(err)
		}
		return state
	}
	before := snapshot()
	broken := append([]migration(nil), schemaMigrations...)
	broken[index].sql += "\nSELECT 1 / 0;"
	if err := migrate(ctx, pool, broken); err == nil {
		t.Fatal("faulted migration succeeded")
	}
	var rolledBack bool
	err = pool.QueryRow(ctx, `SELECT to_regclass('task_steps') IS NOT NULL AND (SELECT count(*)=2 FROM task_steps) AND NOT EXISTS(SELECT FROM schema_migrations WHERE version=124)`).Scan(&rolledBack)
	if err != nil || !rolledBack || snapshot() != before {
		t.Fatalf("migration did not roll back: %t %v", rolledBack, err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	latest := schemaMigrations[len(schemaMigrations)-1].version
	var upgraded bool
	err = pool.QueryRow(ctx, `SELECT to_regclass('task_steps') IS NULL
		AND (SELECT checksum=$1 FROM schema_migrations WHERE version=124)
		AND (SELECT max(version)=$2 FROM schema_migrations)`, schemaMigrations[index].checksum(), latest).Scan(&upgraded)
	if err != nil || !upgraded || snapshot() != before {
		t.Fatalf("upgrade changed retained state or ledger: %t %v", upgraded, err)
	}
	var ledgerBefore, ledgerAfter string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&ledgerBefore); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m`).Scan(&ledgerAfter); err != nil || ledgerBefore != ledgerAfter || snapshot() != before {
		t.Fatalf("restart changed retained state or ledger: %v", err)
	}
}
