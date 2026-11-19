package postgres

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
)

func TestArchiveRetentionMigrationPreservesUnknownPublicationTime(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 89 })
	if index < 1 {
		t.Fatal("missing retention migration")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	project, task := queryID(901), queryID(902)
	if _, err := pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'retention','https://example.test/retention');`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'historical','done')`, task, project); err != nil {
		t.Fatal(err)
	}
	ready, pending := queryID(903), queryID(904)
	for _, id := range []string{ready, pending} {
		if _, err := pool.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$1,$1,$1,'{}','{}')`, id, project, task); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path,updated_at) VALUES($1,'ready',repeat('a',64),5,'old/path','2020-01-01');`, ready); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO session_archives(session_id,state) VALUES($1,'pending')`, pending); err != nil {
		t.Fatal(err)
	}
	var before time.Time
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var first, expires *time.Time
	var grace time.Time
	var version int64
	if err := pool.QueryRow(ctx, `SELECT first_succeeded_at,grace_until,expires_at,version FROM session_archive_retention WHERE session_id=$1`, ready).Scan(&first, &grace, &expires, &version); err != nil {
		t.Fatal(err)
	}
	if first != nil || expires != nil || version != 1 || grace.Before(before.Add(7*24*time.Hour)) {
		t.Fatalf("invented time or short grace: %v %v %v %d", first, grace, expires, version)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM session_archive_retention`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("unpublished archive seeded: %d %v", count, err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if err := pgsession.New(tx).(store.SessionArchiveRetentionDAO).RecordSessionArchiveSuccess(ctx, ready, before); err != nil {
		t.Fatal(err)
	}
	var retained bool
	if err := tx.QueryRow(ctx, `SELECT first_succeeded_at IS NULL AND grace_until=$2 AND version=1 FROM session_archive_retention WHERE session_id=$1`, ready, grace).Scan(&retained); err != nil || !retained {
		t.Fatalf("conversion refreshed legacy success: %v %v", retained, err)
	}
}
