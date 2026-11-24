package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	migration115 "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/schema/migrations/115"
	taskdao "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type workerMigrationRow struct {
	ID         string
	Properties string
	OtherFacts string
}

func workerMigrationRows(t *testing.T, database *Store) []workerMigrationRow {
	t.Helper()
	rows, err := database.Pool.Query(context.Background(), `SELECT id::text,properties,(to_jsonb(t)-'properties'-'deleted_at')::text FROM tasks t ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := []workerMigrationRow{}
	for rows.Next() {
		var row workerMigrationRow
		if err := rows.Scan(&row.ID, &row.Properties, &row.OtherFacts); err != nil {
			t.Fatal(err)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func workerMigrationRelatedFacts(t *testing.T, database *Store) map[string]string {
	t.Helper()
	facts := make(map[string]string)
	for name, query := range map[string]string{
		"projects":     `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text FROM projects t`,
		"attachments":  `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY task_id,path),'[]'::jsonb)::text FROM task_attachments t`,
		"dependencies": `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY project_id,task_id,depends_on_task_id),'[]'::jsonb)::text FROM task_dependencies t`,
		"ledger":       `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t WHERE version<=15`,
	} {
		var value string
		if err := database.Pool.QueryRow(context.Background(), query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		facts[name] = value
	}
	return facts
}

func TestWorkerMigrationPreservesOpaquePropertiesAndExecutionFacts(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:15]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	stamp := time.Date(2026, 10, 24, 1, 2, 3, 123456000, time.UTC)
	properties := []struct{ before, after string }{
		{`{"pullRequests":[]}`, `{"pullRequests":[],"worker":null}`},
		{`{"pullRequests":[{"url":"\u0000","title":"\ud800"}]}`, `{"pullRequests":[{"url":"\u0000","title":"\ud800"}],"worker":null}`},
		{`{"pullRequests":[{"url":"https://example.com/{path}","title":"} quote\" slash\\ 中文"}]}`, `{"pullRequests":[{"url":"https://example.com/{path}","title":"} quote\" slash\\ 中文"}],"worker":null}`},
		{"{\"pullRequests\":[]} \t\n", "{\"pullRequests\":[],\"worker\":null} \t\n"},
	}
	for index, value := range properties {
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,started_at,completed_at,allow_agents,required_platform,properties)
			VALUES($1,$2,'Preserved worker input','## Complete Markdown\nPreserved body',$3,$4,$5,$6,$5,$6,$7,$8,$9)`,
			queryID(index+10), project.ID, []string{"todo", "in_progress", "done", "todo"}[index], int64(9007199254740993)+int64(index), stamp, stamp.Add(time.Hour), index%2 == 0, []any{nil, "linux", "macos", "windows"}[index], value.before)
	}
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, project.ID, queryID(10), queryID(12))
	mustQueryExec(t, database, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'plan.md','text/markdown',123)`, project.ID, queryID(10))
	before, facts := workerMigrationRows(t, database), workerMigrationRelatedFacts(t, database)
	if err := migrate(ctx, pool, schemaMigrations[:16]); err != nil {
		t.Fatal(err)
	}
	after := workerMigrationRows(t, database)
	if len(after) != len(before) || !reflect.DeepEqual(workerMigrationRelatedFacts(t, database), facts) {
		t.Fatal("worker migration changed task inventory or related resources")
	}
	for index, original := range before {
		expected := original
		expected.Properties = properties[index].after
		if !reflect.DeepEqual(after[index], expected) {
			t.Fatalf("migration changed opaque PR bytes or execution facts: expected %#v actual %#v", expected, after[index])
		}
	}
	var applied, repeated time.Time
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=16`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:16]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=16`).Scan(&repeated); err != nil || !applied.Equal(repeated) || !reflect.DeepEqual(workerMigrationRows(t, database), after) {
		t.Fatalf("repeated worker migration changed rows or ledger: %v", err)
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'New task')`, queryID(30), project.ID)
	var created string
	if err := pool.QueryRow(ctx, `SELECT properties FROM tasks WHERE id=$1`, queryID(30)).Scan(&created); err != nil || created != `{"pullRequests":[],"worker":null}` {
		t.Fatalf("new task lacks explicit null worker default: %q %v", created, err)
	}
	current := snapshotHistoricalTask(t, database, project.ID, queryID(30))
	if fixtureWorker(t, current.Properties) != nil || fixturePullRequests(t, current.Properties) == nil {
		t.Fatalf("new task did not decode strict empty properties: %#v", current)
	}
}

func TestWorkerMigrationRollsBackPropertiesDefaultAndLedger(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:15]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,properties) VALUES($1,$2,'Preserved','{"pullRequests":[{"url":"\u0000","title":"\ud800"}]}')`, queryID(10), project.ID)
	mustQueryExec(t, database, `CREATE FUNCTION reject_worker_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.version=16 THEN RAISE EXCEPTION USING ERRCODE='P1016', MESSAGE='worker ledger rejection'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER reject_worker_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_worker_ledger()`)
	before, facts := workerMigrationRows(t, database), workerMigrationRelatedFacts(t, database)
	err := migrate(ctx, pool, schemaMigrations[:16])
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "P1016" {
		t.Fatalf("worker migration lost the ledger failure: %v", err)
	}
	if !reflect.DeepEqual(workerMigrationRows(t, database), before) || !reflect.DeepEqual(workerMigrationRelatedFacts(t, database), facts) {
		t.Fatal("failed worker migration partially changed rows or related resources")
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=16`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("failed worker migration retained its ledger: %d %v", count, err)
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Old default')`, queryID(11), project.ID)
	var originalDefault string
	if err := pool.QueryRow(ctx, `SELECT properties FROM tasks WHERE id=$1`, queryID(11)).Scan(&originalDefault); err != nil || originalDefault != `{"pullRequests":[]}` {
		t.Fatalf("failed worker migration changed default: %q %v", originalDefault, err)
	}
	mustQueryExec(t, database, `DROP TRIGGER reject_worker_ledger ON schema_migrations; DROP FUNCTION reject_worker_ledger()`)
	if err := migrate(ctx, pool, schemaMigrations[:16]); err != nil {
		t.Fatalf("worker migration could not succeed after failure removal: %v", err)
	}
	rows := workerMigrationRows(t, database)
	if rows[0].Properties != `{"pullRequests":[{"url":"\u0000","title":"\ud800"}],"worker":null}` || rows[1].Properties != `{"pullRequests":[],"worker":null}` {
		t.Fatalf("repaired migration did not add worker exactly once: %#v", rows)
	}
}

func TestWorkerModeMigrationPreservesLegacyHistoryAndNullWorkers(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:19]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	worker := `{"claimId":"00000000-0000-4000-8000-000000000001","state":"active","userId":"00000000-0000-4000-8000-000000000002","workerId":"00000000-0000-4000-8000-000000000003","machine":{"id":"00000000-0000-4000-8000-000000000004","name":"Build"},"platform":"linux","agent":"codex","worktreeId":"00000000-0000-4000-8000-000000000005","phase":"executing","herdr":null,"nativeSessionId":"native","claimedAt":"2026-10-24T01:02:03Z"}`
	// PostgreSQL jsonb cannot represent these opaque PR strings; the migration
	// must preserve their JSON bytes without decoding them as PostgreSQL text.
	prs := `[{"url":"\u0000","title":"\ud800"},{"url":"https://example.com/worker","title":"worker and agentControlMode are ordinary text"}]`
	inputs := []string{
		`{"pullRequests":` + prs + `,"worker":` + worker + `}`,
		`{"pullRequests":` + prs + `,"worker":null}`,
		`{"pullRequests":[],"worker":` + strings.Replace(worker, `"state":"active"`, `"state":"released"`, 1) + `}`,
	}
	for i, properties := range inputs {
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,status,version,properties) VALUES($1,$2,'Mode migration',$3,9007199254740993,$4)`, queryID(10+i), project.ID, []string{"in_progress", "todo", "todo"}[i], properties)
	}
	before := workerMigrationRows(t, database)
	for range 2 {
		if err := migrate(ctx, pool, schemaMigrations[:20]); err != nil {
			t.Fatal(err)
		}
		after := workerMigrationRows(t, database)
		for i, row := range after {
			if row.OtherFacts != before[i].OtherFacts || row.ID != before[i].ID {
				t.Fatal("mode migration changed task identity, version, timestamps or status")
			}
			if i == 1 {
				if row.Properties != inputs[i] {
					t.Fatal("null worker properties were rewritten")
				}
				continue
			}
			var original, updated map[string]json.RawMessage
			if err := json.Unmarshal([]byte(inputs[i]), &original); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(row.Properties), &updated); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(original["pullRequests"], updated["pullRequests"]) {
				t.Fatal("mode migration rewrote opaque PR JSON")
			}
			var execution map[string]json.RawMessage
			if err := json.Unmarshal(updated["worker"], &execution); err != nil {
				t.Fatal(err)
			}
			if string(execution["agentControlMode"]) != `"herdr"` {
				t.Fatalf("legacy execution did not persist herdr: %s", updated["worker"])
			}
			if _, err := decodeHistoricalPropertiesFixture([]byte(row.Properties)); err != nil {
				t.Fatalf("migrated history is unreadable: %v", err)
			}
		}
	}
}

func releaseWorkerMigrationIndex(t *testing.T) int {
	t.Helper()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 65 })
	if index < 1 {
		t.Fatal("released worker ownership migration is missing")
	}
	return index
}

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
	index := releaseWorkerMigrationIndex(t)
	migrations := schemaMigrations[:index+1]
	if err := migrate(ctx, pool, migrations[:index]); err != nil {
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
	if err := migrate(ctx, pool, migrations); err != nil {
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
	if err := migrate(ctx, pool, migrations); err != nil {
		t.Fatal(err)
	}
	if after := releaseMigrationState(t, pool); after != state {
		t.Fatal("repeated migration changed data or ledger")
	}
	changed := append([]migration(nil), migrations...)
	changed[index].sql += "\n-- changed checksum"
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
	pool := emptyPool(t)
	index := releaseWorkerMigrationIndex(t)
	migrations := schemaMigrations[:index+1]
	if err := migrate(t.Context(), pool, migrations[:index]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := queryProject(t, db, 1)
	for _, id := range []string{queryID(10), queryID(11)} {
		mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'released')`, id, project.ID)
		mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker','{"state":"released"}'),($1,'sessionStartup','{}')`, id)
	}
	initial := releaseMigrationState(t, pool)

	for _, tc := range []struct{ name, setup, restore, table, code string }{
		{
			name: "invalid JSON", code: "22P02",
			setup:   `UPDATE task_properties SET value='{' WHERE name='worker' AND task_id='00000000-0000-4000-8000-000000000011'`,
			restore: `UPDATE task_properties SET value='{"state":"released"}' WHERE name='worker' AND task_id='00000000-0000-4000-8000-000000000011'`,
		},
		{
			name: "version overflow", code: "22003",
			setup:   `UPDATE tasks SET version=9223372036854775807 WHERE id='00000000-0000-4000-8000-000000000011'`,
			restore: `UPDATE tasks SET version=1 WHERE id='00000000-0000-4000-8000-000000000011'`,
		},
		{
			name: "write failure", table: "projects", code: "P1065",
			setup:   `CREATE FUNCTION reject_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1065', MESSAGE='reject'; END $$; CREATE TRIGGER reject_release BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION reject_release()`,
			restore: `DROP TRIGGER reject_release ON projects; DROP FUNCTION reject_release()`,
		},
		{
			name: "ledger failure", table: "schema_migrations", code: "P1065",
			setup:   `CREATE FUNCTION reject_release() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version=65 THEN RAISE EXCEPTION USING ERRCODE='P1065', MESSAGE='reject'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_release BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_release()`,
			restore: `DROP TRIGGER reject_release ON schema_migrations; DROP FUNCTION reject_release()`,
		},
	} {
		if !t.Run(tc.name, func(t *testing.T) {
			mustQueryExec(t, db, tc.setup)
			before := releaseMigrationState(t, pool)
			err := migrate(t.Context(), pool, migrations)
			var cause *pgconn.PgError
			if !errors.As(err, &cause) || cause.Code != tc.code {
				t.Fatalf("error=%v want SQLSTATE %s", err, tc.code)
			}
			if after := releaseMigrationState(t, pool); after != before {
				t.Fatal("failed migration partially changed data, epochs or ledger")
			}
			mustQueryExec(t, db, tc.restore)
			if tc.table != "" {
				assertFaultTriggerRemoved(t, db, "reject_release", tc.table)
			}
			if after := releaseMigrationState(t, pool); after != initial {
				t.Fatal("release migration fixture was not restored")
			}
		}) {
			return
		}
	}
}

const workerActiveClaimIndex = "task_properties_worker_active_claim_idx"

const workerActiveClaimMigrationPosition = 112

func workerActiveClaimMigrations(t *testing.T) []migration {
	t.Helper()
	if len(schemaMigrations) <= workerActiveClaimMigrationPosition || schemaMigrations[workerActiveClaimMigrationPosition].version != 115 {
		t.Fatal("migration 115 must follow 114 with historical 84/85 gaps")
	}
	return schemaMigrations[:workerActiveClaimMigrationPosition+1]
}

func workerIndexFixture(t *testing.T) string {
	t.Helper()
	worker := &model.WorkerClaim{ClaimID: queryID(101), State: model.WorkerActive, UserID: "ABCDEF01-ABCD-ABCD-ABCD-ABCDEF012345", WorkerID: queryID(103),
		Machine: model.WorkerMachine{ID: queryID(104), Name: "Historical machine"}, Platform: model.PlatformWindows, Agent: model.AgentCodex,
		AgentControlMode: model.AgentControlModeHerdr, WorktreeID: queryID(105), Phase: model.WorkerExecuting,
		Herdr: &model.WorkerHerdr{Session: "s", WorkspaceID: "w", PaneID: "p"}, ClaimedAt: time.Date(2020, 1, 2, 0, 0, 0, 0, time.UTC)}
	raw, err := taskproperty.EncodeWorker(worker)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func workerIndexOldPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	pool := emptyPool(t)
	if err := migrate(t.Context(), pool, workerActiveClaimMigrations(t)[:workerActiveClaimMigrationPosition]); err != nil {
		t.Fatal(err)
	}
	return pool
}

func workerIndexState(t *testing.T, pool *pgxpool.Pool) (ledger bool, definition *string, valid *bool) {
	t.Helper()
	if err := pool.QueryRow(t.Context(), `SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=115),
 (SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indexrelid=to_regclass($1)),
 (SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid=to_regclass($1))`, workerActiveClaimIndex).Scan(&ledger, &definition, &valid); err != nil {
		t.Fatal(err)
	}
	return
}

func TestWorkerActiveClaimMigrationPreservesFactsAndReopens(t *testing.T) {
	pool := workerIndexOldPool(t)
	database := &Store{Pool: pool}
	project := queryProject(t, database, 10)
	for i := range 130 {
		raw := workerIndexFixture(t)
		if i%2 == 1 {
			raw = strings.Replace(raw, `"state":"active"`, `"state":"completed"`, 1)
		}
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,status,version) VALUES($1,$2,'Historical','in_progress',37)`, queryID(1000+i), project.ID)
		mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2),($1,'pullRequests','[{"url":"\u0000","title":"\ud800"}]')`, queryID(1000+i), raw)
	}
	facts := func() string {
		var value string
		if err := pool.QueryRow(t.Context(), `SELECT jsonb_build_object('tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),'properties',(SELECT jsonb_agg(to_jsonb(p) ORDER BY task_id,name) FROM task_properties p),'projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p))::text`).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := facts()
	if err := migrate(t.Context(), pool, workerActiveClaimMigrations(t)); err != nil {
		t.Fatal(err)
	}
	if after := facts(); before != after {
		t.Fatal("index migration changed task, property or Sync fence facts")
	}
	ledger, definition, valid := workerIndexState(t, pool)
	if !ledger || definition == nil || valid == nil || !*valid || !strings.Contains(*definition, `COLLATE "C"`) || !strings.Contains(*definition, "active") {
		t.Fatalf("index not committed: %v %v %v", ledger, definition, valid)
	}
	var checksum string
	if err := pool.QueryRow(t.Context(), `SELECT checksum FROM schema_migrations WHERE version=115`).Scan(&checksum); err != nil || checksum != schemaMigrations[workerActiveClaimMigrationPosition].checksum() {
		t.Fatalf("checksum=%s err=%v", checksum, err)
	}
	reader := func(db *Store) []string {
		t.Helper()
		tx, err := db.Pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(t.Context())
		var ids []string
		page, err := taskdao.NewReader(tx).Tasks(t.Context(), project.ID, store.TaskQuery{Page: store.Page{Limit: 100}, Worker: &store.WorkerQuery{UserID: "ABCDEF01-ABCD-ABCD-ABCD-ABCDEF012345", WorkerID: queryID(103)}})
		if err != nil {
			t.Fatal(err)
		}
		for _, item := range page.Items {
			ids = append(ids, item.ID)
		}
		if page.HasMore {
			t.Fatal("unexpected original inventory continuation")
		}
		mismatch, err := taskdao.NewReader(tx).Tasks(t.Context(), project.ID, store.TaskQuery{Page: store.Page{Limit: 100}, Worker: &store.WorkerQuery{UserID: "abcdef01-abcd-abcd-abcd-abcdef012345", WorkerID: queryID(103)}})
		if err != nil || len(mismatch.Items) != 0 {
			t.Fatalf("original inventory lost exact UUID comparison: %d %v", len(mismatch.Items), err)
		}
		return ids
	}
	want := reader(database)
	if len(want) != 65 {
		t.Fatalf("active claims=%d", len(want))
	}
	if err := migrate(t.Context(), pool, workerActiveClaimMigrations(t)); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(t.Context(), pool.Config().ConnString())
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if got := reader(reopened); !reflect.DeepEqual(got, want) {
		t.Fatal("current-ledger startup changed claims")
	}
	if err := migrate(t.Context(), pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerActiveClaimMigrationRejectsInvalidRowsAtomically(t *testing.T) {
	pool := workerIndexOldPool(t)
	for _, test := range []struct{ name, raw, reason string }{
		{"shape", `{}`, "worker shape"}, {"invalid JSON", `{`, "worker shape"},
		{"duplicate", strings.Replace(workerIndexFixture(t), `"state":"active"`, `"state":"active","state":"completed"`, 1), "worker shape"},
		{"PostgreSQL conversion", strings.Replace(workerIndexFixture(t), "Historical machine", `\ud800`, 1), "PostgreSQL worker extraction"},
	} {
		if !t.Run(test.name, func(t *testing.T) {
			id := queryID(1000)
			if _, err := pool.Exec(t.Context(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, id, test.raw); err != nil {
				t.Fatal(err)
			}
			err := migrate(t.Context(), pool, workerActiveClaimMigrations(t))
			var transaction *store.TransactionError
			var propertyError *migration115.WorkerPropertyError
			if err == nil || !errors.As(err, &transaction) || !errors.As(err, &propertyError) || propertyError.TaskID != id || !workerMigrationErrorContains(transaction.Cause, id) || !workerMigrationErrorContains(transaction.Cause, test.reason) {
				t.Fatalf("failure lacks Task identity/reason: %v", err)
			}
			if propertyError.Unwrap() == nil {
				t.Fatal("migration discarded worker failure cause")
			}
			if test.name == "PostgreSQL conversion" {
				var postgresError *pgconn.PgError
				if !errors.As(err, &postgresError) {
					t.Fatal("PostgreSQL conversion cause was lost")
				}
			}
			ledger, definition, valid := workerIndexState(t, pool)
			if ledger || definition != nil || valid != nil {
				t.Fatal("failed migration left index or ledger")
			}
			var raw string
			if err := pool.QueryRow(t.Context(), `SELECT value FROM task_properties WHERE task_id=$1 AND name='worker'`, id).Scan(&raw); err != nil || raw != test.raw {
				t.Fatalf("raw property changed: %v", err)
			}
			assertMigrationPoolReusable(t, pool)
			if _, err := pool.Exec(t.Context(), `DELETE FROM task_properties WHERE task_id=$1 AND name='worker'`, id); err != nil {
				t.Fatal(err)
			}
		}) {
			return
		}
	}
}

func workerMigrationErrorContains(err error, text string) bool {
	if err == nil {
		return false
	}
	if strings.Contains(err.Error(), text) {
		return true
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, cause := range joined.Unwrap() {
			if workerMigrationErrorContains(cause, text) {
				return true
			}
		}
		return false
	}
	return workerMigrationErrorContains(errors.Unwrap(err), text)
}

func TestWorkerActiveClaimMigrationShareLockAndCancellation(t *testing.T) {
	pool := workerIndexOldPool(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	blocker, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `LOCK TABLE task_properties IN ROW EXCLUSIVE MODE`); err != nil {
		t.Fatal(err)
	}
	instance, application := migrationInstance(t, pool)
	migrationCtx, stop := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- migrate(migrationCtx, instance, workerActiveClaimMigrations(t)) }()
	waitForMigration(t, func() bool {
		var waiting bool
		return pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE l.relation='task_properties'::regclass AND l.mode='ShareLock' AND NOT l.granted AND a.application_name=$1)`, application).Scan(&waiting) == nil && waiting
	})
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_properties`).Scan(&count); err != nil {
		t.Fatal("SHARE wait blocked reader", err)
	}
	stop()
	if err := <-done; err == nil || !(errors.Is(err, context.Canceled) || strings.Contains(err.Error(), "context canceled")) {
		t.Fatalf("cancellation=%v", err)
	}
	ledger, definition, _ := workerIndexState(t, pool)
	if ledger || definition != nil {
		t.Fatal("cancelled migration committed")
	}
	if err := blocker.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, workerActiveClaimMigrations(t)); err != nil {
		t.Fatal(err)
	}
	assertMigrationPoolReusable(t, instance)
}

func TestWorkerActiveClaimMigrationShareLockAllowsReadsAndWaitsWrites(t *testing.T) {
	pool := workerIndexOldPool(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	next := schemaMigrations[workerActiveClaimMigrationPosition]
	if _, err := tx.Exec(ctx, next.sql); err != nil {
		t.Fatal(err)
	}
	if err := next.transform(ctx, tx); err != nil {
		t.Fatal(err)
	}
	writer, application := migrationInstance(t, pool)
	done := make(chan error, 1)
	go func() {
		_, err := writer.Exec(ctx, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests','[]')`, queryID(2000))
		done <- err
	}()
	waitForMigration(t, func() bool {
		var waiting bool
		return pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_locks l JOIN pg_stat_activity a USING(pid) WHERE l.relation='task_properties'::regclass AND l.mode='RowExclusiveLock' AND NOT l.granted AND a.application_name=$1)`, application).Scan(&waiting) == nil && waiting
	})
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_properties`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("reader failed during SHARE lock: %d %v", count, err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	ledger, definition, _ := workerIndexState(t, pool)
	if ledger || definition != nil {
		t.Fatal("rollback retained index or ledger")
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM task_properties WHERE task_id=$1`, queryID(2000)).Scan(&count); err != nil || count != 1 {
		t.Fatalf("waiting write did not commit: %d %v", count, err)
	}
}

func TestWorkerActiveClaimIndexMaintainsMembership(t *testing.T) {
	pool := workerIndexOldPool(t)
	raw := workerIndexFixture(t)
	if _, err := pool.Exec(t.Context(), `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, queryID(1000), raw); err != nil {
		t.Fatal(err)
	}
	if err := migrate(t.Context(), pool, workerActiveClaimMigrations(t)); err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(raw), &fields); err != nil {
		t.Fatal(err)
	}
	fields["state"] = json.RawMessage(`"completed"`)
	completed, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(t.Context(), `UPDATE task_properties SET value=$2 WHERE task_id=$1 AND name='worker'`, queryID(1000), string(completed)); err != nil {
		t.Fatal(err)
	}
	var count int
	tx, err := pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(t.Context())
	if _, err := tx.Exec(t.Context(), `SET LOCAL enable_seqscan=off`); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(t.Context(), `SELECT count(*) FROM task_properties WHERE name='worker' AND ((CASE WHEN name='worker' THEN value::jsonb END)->>'state') COLLATE "C"='active'`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("completed index member retained: %d %v", count, err)
	}
	var plan string
	if err := tx.QueryRow(t.Context(), `EXPLAIN (ANALYZE,FORMAT JSON) SELECT task_id FROM task_properties WHERE name='worker' AND ((CASE WHEN name='worker' THEN value::jsonb END)->>'state') COLLATE "C"='active'`).Scan(&plan); err != nil || !strings.Contains(plan, workerActiveClaimIndex) {
		t.Fatalf("index membership not exercised: %s %v", plan, err)
	}
}
