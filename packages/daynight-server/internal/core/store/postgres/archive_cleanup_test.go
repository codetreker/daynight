package postgres

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestArchiveCleanupMigrationRetainsPendingDeletion(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 92 })
	if index < 1 {
		t.Fatal("missing cleanup migration")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	id := queryID(901)
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	if _, err := pool.Exec(ctx, `INSERT INTO session_archive_retention(session_id,expired_at,reason,version) VALUES($1,$2,'expired',7)`, id, at); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var expired time.Time
	var cleaned *time.Time
	var version int64
	if err := pool.QueryRow(ctx, `SELECT expired_at,cleaned_at,version FROM session_archive_retention WHERE session_id=$1`, id).Scan(&expired, &cleaned, &version); err != nil || !expired.Equal(at) || cleaned != nil || version != 7 {
		t.Fatalf("migration changed pending cleanup: %v %v %d %v", expired, cleaned, version, err)
	}
	_, err := pool.Exec(ctx, `INSERT INTO session_archive_retention(session_id,cleaned_at) VALUES($1,$2)`, queryID(902), at)
	var constraint *pgconn.PgError
	if !errors.As(err, &constraint) || constraint.Code != "23514" {
		t.Fatalf("cleanup without expiration accepted: %v", err)
	}
}

func TestArchiveCleanupMigrationStartsLegacyGraceAtEnablement(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := emptyPool(t)
	retentionIndex := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 89 })
	cleanupIndex := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 92 })
	if retentionIndex < 1 || cleanupIndex <= retentionIndex {
		t.Fatal("missing ordered retention and cleanup migrations")
	}
	if err := migrate(ctx, pool, schemaMigrations[:retentionIndex]); err != nil {
		t.Fatal(err)
	}
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	project, task := queryID(910), queryID(911)
	exec(`INSERT INTO projects(id,name,repo_url) VALUES($1,'cleanup-grace','https://example.test/cleanup-grace')`, project)
	exec(`INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'historical','done')`, task, project)
	old, later, expired := queryID(912), queryID(913), queryID(914)
	createArchive := func(id string) {
		t.Helper()
		exec(`INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$1,$1,$1,'{}','{}')`, id, project, task)
		exec(`INSERT INTO session_archives(session_id,state,sha256,byte_length,object_path) VALUES($1,'ready',repeat('a',64),7,'historical/archive')`, id)
	}
	for _, id := range []string{old, later, expired} {
		createArchive(id)
	}
	// Migration 089 really seeds legacy ownership before a later binary enables GC.
	if err := migrate(ctx, pool, schemaMigrations[:retentionIndex+1]); err != nil {
		t.Fatal(err)
	}
	var initialLegacy int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM session_archive_retention WHERE first_succeeded_at IS NULL AND grace_until IS NOT NULL`).Scan(&initialLegacy); err != nil || initialLegacy != 3 {
		t.Fatalf("legacy seed=%d %v", initialLegacy, err)
	}
	var before time.Time
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	oldGrace, laterGrace := before.Add(-24*time.Hour), before.Add(30*24*time.Hour)
	exec(`UPDATE session_archive_retention SET grace_until=$2,expires_at=$2 WHERE session_id=$1`, old, oldGrace)
	exec(`UPDATE session_archive_retention SET grace_until=$2 WHERE session_id=$1`, later, laterGrace)
	exec(`UPDATE session_archive_retention SET grace_until=$2,expires_at=$2,expired_at=$2,reason='expired',version=7 WHERE session_id=$1`, expired, oldGrace)
	known, unknown := queryID(915), queryID(916)
	body, schema3Legacy, pending, failed := queryID(917), queryID(918), queryID(919), queryID(920)
	for _, id := range []string{known, unknown, body, schema3Legacy, pending, failed} {
		createArchive(id)
	}
	for _, id := range []string{known, body, schema3Legacy, pending, failed} {
		exec(`INSERT INTO session_archive_retention(session_id,first_succeeded_at) VALUES($1,$2)`, id, oldGrace)
	}
	exec(`INSERT INTO session_archive_retention(session_id) VALUES($1)`, unknown)
	for _, id := range []string{body, schema3Legacy} {
		exec(`UPDATE session_archives SET schema_version=3,completeness='complete' WHERE session_id=$1`, id)
		ledger := `{}`
		if id == body {
			ledger = `{"ContentPolicy":"task_body"}`
		}
		exec(`INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity,ledger) VALUES($1,$1,'committed',1,'{}',$2)`, id, ledger)
	}
	for _, entry := range []struct{ id, state string }{{pending, "pending"}, {failed, "failed"}} {
		exec(`UPDATE session_archives SET state=$2,sha256=NULL,byte_length=NULL,object_path=NULL WHERE session_id=$1`, entry.id, entry.state)
	}
	var originalExpired string
	if err := pool.QueryRow(ctx, `SELECT to_jsonb(r)::text FROM session_archive_retention r WHERE session_id=$1`, expired).Scan(&originalExpired); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:cleanupIndex]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:cleanupIndex+1]); err != nil {
		t.Fatal(err)
	}
	var after time.Time
	if err := pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{old, later, known, unknown, body, schema3Legacy, pending, failed} {
		var first, grace, expires *time.Time
		var version int64
		var reason string
		if err := pool.QueryRow(ctx, `SELECT first_succeeded_at,grace_until,expires_at,version,reason FROM session_archive_retention WHERE session_id=$1`, id).Scan(&first, &grace, &expires, &version, &reason); err != nil {
			t.Fatal(err)
		}
		changed := id == old || id == known || id == unknown || id == schema3Legacy
		wantVersion := int64(1)
		if changed {
			wantVersion++
		}
		if expires != nil || version != wantVersion || reason != "pending" {
			t.Fatalf("enablement cache/version changed incorrectly for %s: expires=%v version=%d reason=%s", id, expires, version, reason)
		}
		switch id {
		case old:
			if first != nil || grace == nil || grace.Before(before.Add(168*time.Hour)) || grace.After(after.Add(168*time.Hour)) {
				t.Fatalf("cleanup enablement did not establish seven-day floor: first=%v grace=%v bounds=%v..%v", first, grace, before, after)
			}
		case later:
			if first != nil || grace == nil || !grace.Equal(laterGrace) {
				t.Fatalf("later legacy grace shortened: %v %v", first, grace)
			}
		case known, schema3Legacy, unknown:
			if grace == nil || grace.Before(before.Add(168*time.Hour)) || grace.After(after.Add(168*time.Hour)) {
				t.Fatalf("legacy archive %s missed enablement grace: %v", id, grace)
			}
			if id == unknown {
				if first != nil {
					t.Fatalf("unknown legacy publication invented: %v", first)
				}
			} else if first == nil || !first.Equal(oldGrace) {
				t.Fatalf("known legacy publication changed: %v", first)
			}
		case body, pending, failed:
			if first == nil || !first.Equal(oldGrace) || grace != nil {
				t.Fatalf("nonlegacy or unready archive %s gained legacy grace: %v %v", id, first, grace)
			}
		}
	}
	var retainedExpired string
	if err := pool.QueryRow(ctx, `SELECT (to_jsonb(r)-'cleaned_at')::text FROM session_archive_retention r WHERE session_id=$1`, expired).Scan(&retainedExpired); err != nil || retainedExpired != originalExpired {
		t.Fatalf("expired tombstone changed: %s != %s: %v", retainedExpired, originalExpired, err)
	}
	snapshot := func() string {
		t.Helper()
		var value string
		if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(r) ORDER BY session_id)::text FROM session_archive_retention r`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	committed := snapshot()
	if err := migrate(ctx, pool, schemaMigrations[:cleanupIndex+1]); err != nil {
		t.Fatal(err)
	}
	if repeated := snapshot(); repeated != committed {
		t.Fatalf("repeat migration renewed retention: %s != %s", repeated, committed)
	}
}
