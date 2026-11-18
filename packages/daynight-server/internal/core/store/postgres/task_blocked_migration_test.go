package postgres

import (
	"testing"
)

func TestTaskBlockedMigrationPreservesFactsAndHistory(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	beforeMigrations := schemaMigrations[:len(schemaMigrations)-1]
	if schemaMigrations[len(schemaMigrations)-1].version != 87 {
		t.Fatal("expected blocked property migration as the latest migration")
	}
	if err := migrate(ctx, pool, beforeMigrations); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := queryProject(t, db, 1)
	for i := 0; i < 4; i++ {
		mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title,status,version,created_at,updated_at,deleted_at)
 VALUES($1,$2,'Preserved','todo',17,'2026-01-01T10:00:00Z','2026-01-01T11:00:00Z', CASE WHEN $3=2 THEN '2026-01-02T00:00:00Z'::timestamptz ELSE NULL END)`, queryID(10+i), project.ID, i)
	}
	mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES
 ($1,'paused','true'),($2,'paused','false'),($3,'paused',' true '),($1,'worker','{"retained":true}'),($2,'pullRequests','[]')`, queryID(10), queryID(11), queryID(12))
	mustQueryExec(t, db, `INSERT INTO webhook_events
 (id,event_type,wire_version,schema_version,source,subject,project_id,task_id,task_version,
 occurred_at,recorded_at,fact_codec_version,fact_bytes,fact_sha256,original_fact_bytes)
 VALUES($1,'task.paused',1,1,'urn:daynight:project:' || $2::uuid::text,'tasks/' || $3::uuid::text,$2,$3,17,
 '2026-01-01T10:00:00Z','2026-01-01T10:00:01Z',1,convert_to('{}','UTF8'),sha256(convert_to('{}','UTF8')),2)`, queryID(90), project.ID, queryID(10))
	snapshot := func(normalize bool) string {
		t.Helper()
		var value string
		err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),
 'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),
 'properties',(SELECT jsonb_agg(jsonb_build_object('task',task_id,'name',CASE WHEN $1 AND name='paused' THEN 'blocked' ELSE name END,'value',value) ORDER BY task_id,CASE WHEN $1 AND name='paused' THEN 'blocked' ELSE name END) FROM task_properties),
 'webhookEvents',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb) FROM webhook_events e))::text`, normalize).Scan(&value)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := snapshot(true)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if after := snapshot(false); after != before {
		t.Fatalf("migration changed task facts beyond the property name: before=%s after=%s", before, after)
	}
	var value string
	if err := pool.QueryRow(ctx, `SELECT value FROM task_properties WHERE task_id=$1 AND name='blocked'`, queryID(12)).Scan(&value); err != nil || value != " true " {
		t.Fatalf("deleted task property was not migrated: %q, %v", value, err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_properties WHERE task_id=$1 AND name IN ('paused','blocked')`, queryID(13)).Scan(&count); err != nil || count != 0 {
		t.Fatalf("absent property changed: count=%d, %v", count, err)
	}
	var applied string
	if err := pool.QueryRow(ctx, `SELECT applied_at::text FROM schema_migrations WHERE version=87`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var repeated string
	if err := pool.QueryRow(ctx, `SELECT applied_at::text FROM schema_migrations WHERE version=87`).Scan(&repeated); err != nil || repeated != applied || snapshot(false) != before {
		t.Fatalf("replay changed facts or ledger: %v", err)
	}
}

func TestTaskBlockedMigrationRejectsBadRowsAtomically(t *testing.T) {
	for _, tc := range []struct {
		name, property, value string
		conflict              bool
	}{
		{"malformed", "paused", "{", false},
		{"nonboolean", "paused", `"true"`, false},
		{"null", "paused", "null", false},
		{"bad canonical", "blocked", "1", false},
		{"conflict", "blocked", "false", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			pool := emptyPool(t)
			if err := migrate(ctx, pool, schemaMigrations[:len(schemaMigrations)-1]); err != nil {
				t.Fatal(err)
			}
			db := &Store{Pool: pool}
			project := queryProject(t, db, 1)
			for i := 0; i < 2; i++ {
				mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Task')`, queryID(i+10), project.ID)
			}
			mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'paused','true')`, queryID(10))
			id := queryID(11)
			if tc.conflict {
				id = queryID(10)
			}
			mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,$2,$3)`, id, tc.property, tc.value)
			var before, after string
			read := `SELECT jsonb_build_object('rows',(SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id,name) FROM task_properties p),'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m))::text`
			if err := pool.QueryRow(ctx, read).Scan(&before); err != nil {
				t.Fatal(err)
			}
			if err := migrate(ctx, pool, schemaMigrations); err == nil {
				t.Fatal("invalid data was accepted")
			}
			if err := pool.QueryRow(ctx, read).Scan(&after); err != nil || before != after {
				t.Fatalf("failed migration changed rows or ledger: before=%s after=%s err=%v", before, after, err)
			}
			mustQueryExec(t, db, `DELETE FROM task_properties WHERE task_id=$1 AND name=$2`, id, tc.property)
			if err := migrate(ctx, pool, schemaMigrations); err != nil {
				t.Fatalf("repaired migration: %v", err)
			}
		})
	}
}
