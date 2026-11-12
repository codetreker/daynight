package postgres

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func releaseMigrationState(t *testing.T, pool *pgxpool.Pool) string {
	t.Helper()
	var state string
	err := pool.QueryRow(t.Context(), `SELECT jsonb_build_object(
 'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),
 'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id,name) FROM task_properties p),
 'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),
 'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY task_id,path) FROM task_attachments a),
 'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM task_sessions s),
 'archives',(SELECT jsonb_agg(to_jsonb(a) ORDER BY session_id) FROM session_archives a),
 'ledger',(SELECT jsonb_agg(to_jsonb(m) ORDER BY version) FROM schema_migrations m))::text`).Scan(&state)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func TestReleaseWorkerMigrationPreservesMaterialsAndHistory(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:64]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := queryProject(t, db, 1)
	other := queryProject(t, db, 2)
	stamp := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title,type,status,version,created_at,updated_at,deleted_at)
 VALUES($1,$2,'Deleted parent','goal','todo',7,$3,$3,$3)`, queryID(9), project.ID, stamp)
	for i, status := range []string{"todo", "todo", "todo", "cancelled", "in_progress", "done", "todo"} {
		mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,started_at,completed_at,cancelled_at,deleted_at,parent_id,allow_agents,required_platform)
 VALUES($1,$2,'Preserved title','material',$3,9007199254740993,$4,$4,$4,$4,CASE WHEN $3='cancelled' THEN $4::timestamptz ELSE NULL END,CASE WHEN $5::integer=1 THEN $4::timestamptz ELSE NULL END,CASE WHEN $5::integer=2 THEN $6::uuid ELSE NULL END,true,'linux')`, queryID(10+i), project.ID, status, stamp, i, queryID(9))
		state := []string{"released", "released", "released", "released", "active", "completed", "none"}[i]
		if state != "none" {
			mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2),($1,'sessionStartup','{"state":"ready"}')`, queryID(10+i), `{"state":"`+state+`","claimId":"retained in history"}`)
		}
		mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests','[{"url":"https://example.test","title":"retained"}]')`, queryID(10+i))
	}
	mustQueryExec(t, db, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'result.md','text/markdown',123)`, project.ID, queryID(10))
	mustQueryExec(t, db, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}','{}')`, queryID(30), project.ID, queryID(10), queryID(31), queryID(32), queryID(33))
	mustQueryExec(t, db, `INSERT INTO session_archives(session_id,state) VALUES($1,'pending')`, queryID(30))
	var beforeFacts, beforeOther, epoch, otherEpoch string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t)-'version'-'updated_at' ORDER BY id)::text FROM tasks t`).Scan(&beforeFacts); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t WHERE id >= $1`, queryID(14)).Scan(&beforeOther); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, other.ID).Scan(&otherEpoch); err != nil {
		t.Fatal(err)
	}
	var beforeHistory string
	if err := pool.QueryRow(ctx, `SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(a)) FROM task_attachments a),(SELECT jsonb_agg(to_jsonb(s)) FROM task_sessions s),(SELECT jsonb_agg(to_jsonb(a)) FROM session_archives a))::text`).Scan(&beforeHistory); err != nil {
		t.Fatal(err)
	}
	beforeTime := time.Now().UTC().Add(-time.Second)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var afterFacts, afterOther, afterEpoch, afterOtherEpoch, afterHistory string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t)-'version'-'updated_at' ORDER BY id)::text FROM tasks t`).Scan(&afterFacts); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t WHERE id >= $1`, queryID(14)).Scan(&afterOther); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&afterEpoch); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, other.ID).Scan(&afterOtherEpoch); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT jsonb_build_array((SELECT jsonb_agg(to_jsonb(a)) FROM task_attachments a),(SELECT jsonb_agg(to_jsonb(s)) FROM task_sessions s),(SELECT jsonb_agg(to_jsonb(a)) FROM session_archives a))::text`).Scan(&afterHistory); err != nil {
		t.Fatal(err)
	}
	if beforeFacts != afterFacts || beforeOther != afterOther || beforeHistory != afterHistory || epoch == afterEpoch || otherEpoch != afterOtherEpoch {
		t.Fatal("migration changed unrelated task facts, history or project epochs")
	}
	for i := 0; i < 7; i++ {
		var version int64
		var updated time.Time
		var worker, startup, ordinary int
		if err := pool.QueryRow(ctx, `SELECT version,updated_at,(SELECT count(*) FROM task_properties WHERE task_id=$1 AND name='worker'),(SELECT count(*) FROM task_properties WHERE task_id=$1 AND name='sessionStartup'),(SELECT count(*) FROM task_properties WHERE task_id=$1 AND name='pullRequests') FROM tasks WHERE id=$1`, queryID(10+i)).Scan(&version, &updated, &worker, &startup, &ordinary); err != nil {
			t.Fatal(err)
		}
		if i < 4 {
			if version != 9007199254740994 || updated.Before(beforeTime) || worker != 0 || startup != 0 || ordinary != 1 {
				t.Fatalf("affected %d: version=%d updated=%v worker=%d startup=%d ordinary=%d", i, version, updated, worker, startup, ordinary)
			}
		} else if version != 9007199254740993 || !updated.Equal(stamp) || worker != boolCount(i != 6) || startup != boolCount(i != 6) || ordinary != 1 {
			t.Fatalf("unaffected %d: version=%d updated=%v worker=%d startup=%d ordinary=%d", i, version, updated, worker, startup, ordinary)
		}
	}
	state := releaseMigrationState(t, pool)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if after := releaseMigrationState(t, pool); after != state {
		t.Fatal("repeated migration changed data or ledger")
	}
	changed := append([]migration(nil), schemaMigrations...)
	changed[64].sql += "\n-- changed checksum"
	if err := migrate(ctx, pool, changed); err == nil {
		t.Fatal("changed migration checksum was accepted")
	}
	if after := releaseMigrationState(t, pool); after != state {
		t.Fatal("checksum refusal changed data")
	}
}

func boolCount(value bool) int {
	if value {
		return 1
	}
	return 0
}

func TestReleaseWorkerMigrationFailsAtomically(t *testing.T) {
	for _, tc := range []struct{ name, setup, code string }{
		{"invalid JSON", `UPDATE task_properties SET value='{' WHERE name='worker' AND task_id='00000000-0000-4000-8000-000000000011'`, "22P02"},
		{"version overflow", `UPDATE tasks SET version=9223372036854775807 WHERE id='00000000-0000-4000-8000-000000000011'`, "22003"},
		{"write failure", `CREATE FUNCTION reject_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1065', MESSAGE='reject'; END $$; CREATE TRIGGER reject_release BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION reject_release()`, "P1065"},
		{"ledger failure", `CREATE FUNCTION reject_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version=65 THEN RAISE EXCEPTION USING ERRCODE='P1065', MESSAGE='reject'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_release BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_release()`, "P1065"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			pool := emptyPool(t)
			if err := migrate(ctx, pool, schemaMigrations[:64]); err != nil {
				t.Fatal(err)
			}
			db := &Store{Pool: pool}
			project := queryProject(t, db, 1)
			for _, id := range []string{queryID(10), queryID(11)} {
				mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'released')`, id, project.ID)
				mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','{"state":"released"}'),($1,'sessionStartup','{}')`, id)
			}
			mustQueryExec(t, db, tc.setup)
			before := releaseMigrationState(t, pool)
			err := migrate(ctx, pool, schemaMigrations)
			var cause *pgconn.PgError
			if !errors.As(err, &cause) || cause.Code != tc.code {
				t.Fatalf("error=%v want SQLSTATE %s", err, tc.code)
			}
			if after := releaseMigrationState(t, pool); !reflect.DeepEqual(after, before) {
				t.Fatal("failed migration partially changed data, epochs or ledger")
			}
		})
	}
}
