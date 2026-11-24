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
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskPropertiesMigrationPreservesExistingResource(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:2]); err != nil {
		t.Fatal(err)
	}
	projectID, taskID := queryID(1), queryID(2)
	created := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	updated := created.Add(time.Hour)
	if _, err := pool.Exec(ctx, "INSERT INTO projects (id,name,repo_url) VALUES ($1,'Existing','host:repo')", projectID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO tasks (id,project_id,title,description,status,version,created_at,updated_at)
		VALUES ($1,$2,'Existing task','Existing description','done',17,$3,$4)`, taskID, projectID, created, updated); err != nil {
		t.Fatal(err)
	}
	var missing bool
	if err := pool.QueryRow(ctx, `SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns
		WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='properties')`).Scan(&missing); err != nil || !missing {
		t.Fatalf("fixture was not an actual old schema: %v, %v", missing, err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:31]); err != nil {
		t.Fatal(err)
	}
	if err := seedHistoricalProjectAdmin(ctx, &Store{Pool: pool}, projectID); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	task := snapshotTask(t, database, projectID, taskID)
	if task.Title != "Existing task" || task.Description != "Existing description" || task.Status != model.TaskDone || task.Version != 17 || !task.CreatedAt.Equal(created) || !task.UpdatedAt.Equal(updated) || fixturePullRequests(t, task.Properties) == nil || len(fixturePullRequests(t, task.Properties)) != 0 {
		t.Fatalf("migration changed old resource: %#v", task)
	}
	var applied time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=3").Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var after time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=3").Scan(&after); err != nil || !after.Equal(applied) || !reflect.DeepEqual(snapshotTask(t, database, projectID, taskID), task) {
		t.Fatalf("repeated migration changed ledger/resource: %v, %v", after, err)
	}
}

// Pre-permission rows receive true through migration; project it explicitly while comparing all historical fields.
func snapshotTaskBeforePermission(t *testing.T, database *Store, projectID, id string) model.Task {
	t.Helper()
	task, err := scanHistoricalTask(database.Pool.QueryRow(context.Background(), `SELECT
  t.id::text,t.project_id::text,t.title,t.description,t.status,t.version,
  t.created_at,t.updated_at,t.started_at,t.completed_at,true,NULL::text,t.properties,`+
		historicalTaskDependsOn+`,ARRAY[]::text[],`+historicalTaskBlockedBy+`,`+historicalTaskReady+` FROM tasks t WHERE t.project_id=$1 AND t.id=$2`, projectID, id))
	if err != nil {
		t.Fatal(err)
	}
	return task
}

func TestTaskAgentPermissionMigrationPreservesHistoryAndDefaults(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:10]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	var before []model.Task
	for index, status := range []model.TaskStatus{model.TaskStatus("proposed"), model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		id := queryID(index + 10)
		var started, completed *time.Time
		if status == model.TaskInProgress || status == model.TaskDone {
			start := stamp.Add(time.Minute)
			started = &start
		}
		if status == model.TaskDone {
			end := stamp.Add(2 * time.Minute)
			completed = &end
		}
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,started_at,completed_at,properties)
   VALUES($1,$2,'Historical permission','Preserved',$3,$4,$5,$6,$7,$8,'{"pullRequests":[{"url":"https://example.com/pr/1","title":"Preserved"}]}')`, id, project.ID, status, index+17, stamp, stamp.Add(time.Hour), started, completed)
	}
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project.ID, queryID(10), queryID(11))
	for index := range 4 {
		before = append(before, snapshotTaskBeforePermission(t, database, project.ID, queryID(index+10)))
	}
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	for _, original := range before {
		if after := snapshotHistoricalTask(t, database, project.ID, original.ID); !after.AllowAgents || !reflect.DeepEqual(original, after) {
			t.Fatalf("permission migration changed historical resource: before %#v, after %#v", original, after)
		}
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'New SQL task')`, queryID(20), project.ID)
	created := snapshotHistoricalTask(t, database, project.ID, queryID(20))
	if created.AllowAgents || created.Status != model.TaskStatus("proposed") || created.Version != 1 || !created.CreatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("new SQL defaults: %#v", created)
	}
	_, err := pool.Exec(ctx, `UPDATE tasks SET allow_agents=NULL WHERE id=$1`, created.ID)
	var constraint *pgconn.PgError
	if !errors.As(err, &constraint) || constraint.Code != "23502" {
		t.Fatalf("null permission bypassed storage: %v", err)
	}
	var applied, repeated time.Time
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=11`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=11`).Scan(&repeated); err != nil || !applied.Equal(repeated) || !reflect.DeepEqual(snapshotHistoricalTask(t, database, project.ID, created.ID), created) {
		t.Fatalf("permission migration rerun changed ledger or new resource: %v", err)
	}
	for _, original := range before {
		if after := snapshotHistoricalTask(t, database, project.ID, original.ID); !reflect.DeepEqual(original, after) {
			t.Fatalf("migration rerun changed history: %#v", after)
		}
	}
}

func TestTaskPlatformMigrationPreservesHistoryAndConstrainsValues(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	for index, status := range []model.TaskStatus{model.TaskStatus("proposed"), model.TaskTodo, model.TaskInProgress, model.TaskDone} {
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,started_at,completed_at,allow_agents,properties)
		 VALUES($1,$2,'Platform history','Preserved',$3,$4,$5,$6,$5,$6,$7,'{"pullRequests":[{"url":"https://example.com/pr/1","title":"Preserved"}]}')`, queryID(index+10), project.ID, status, index+17, stamp, stamp.Add(time.Hour), index%2 == 0)
	}
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, project.ID, queryID(11), queryID(13))
	mustQueryExec(t, database, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'plan.md','text/markdown',123)`, project.ID, queryID(11))
	facts := func() map[string]string {
		result := make(map[string]string)
		for name, query := range map[string]string{
			"tasks":        `SELECT jsonb_agg(to_jsonb(t)-'required_platform' ORDER BY id)::text FROM tasks t`,
			"dependencies": `SELECT jsonb_agg(to_jsonb(t) ORDER BY task_id)::text FROM task_dependencies t`,
			"attachments":  `SELECT jsonb_agg(to_jsonb(t) ORDER BY task_id)::text FROM task_attachments t`,
			"ledger":       `SELECT jsonb_agg(to_jsonb(t) ORDER BY version)::text FROM schema_migrations t WHERE version<=12`,
		} {
			var value string
			if err := pool.QueryRow(ctx, query).Scan(&value); err != nil {
				t.Fatal(err)
			}
			result[name] = value
		}
		return result
	}
	read := func(id string) model.Task {
		t.Helper()
		task, err := scanHistoricalTask(pool.QueryRow(ctx, `SELECT `+historicalPlatformTaskProjection+` FROM tasks t WHERE t.project_id=$1 AND t.id=$2`, project.ID, id))
		if err != nil {
			t.Fatal(err)
		}
		return task
	}
	before := facts()
	if err := migrate(ctx, pool, schemaMigrations[:13]); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, facts()) {
		t.Fatal("platform migration changed historical facts")
	}
	for index := range 4 {
		if read(queryID(index+10)).RequiredPlatform != nil {
			t.Fatal("historical task acquired a platform requirement")
		}
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Unrestricted new task')`, queryID(20), project.ID)
	created := read(queryID(20))
	if created.RequiredPlatform != nil || created.AllowAgents || created.Status != model.TaskStatus("proposed") || created.Ready || created.Version != 1 {
		t.Fatalf("new defaults: %#v", created)
	}
	for _, platform := range []string{"windows", "linux", "macos", "", "darwin", "Windows"} {
		_, err := pool.Exec(ctx, `UPDATE tasks SET required_platform=$1 WHERE id=$2`, platform, created.ID)
		if model.TaskPlatform(platform).Valid() {
			if err != nil {
				t.Fatal(err)
			}
			if actual := read(created.ID).RequiredPlatform; actual == nil || string(*actual) != platform {
				t.Fatal("storage lost required platform")
			}
		} else {
			var constraint *pgconn.PgError
			if !errors.As(err, &constraint) || constraint.Code != "23514" {
				t.Fatalf("invalid platform bypassed storage: %v", err)
			}
		}
	}
	mustQueryExec(t, database, `UPDATE tasks SET required_platform=NULL WHERE id=$1`, created.ID)
	var applied, repeated time.Time
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=13`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:13]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=13`).Scan(&repeated); err != nil || !applied.Equal(repeated) || !reflect.DeepEqual(created, read(created.ID)) {
		t.Fatalf("repeated migration changed ledger or resource: %v", err)
	}
}

func TestTaskAssignmentMigrationPreservesExistingFacts(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:27]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	for index, status := range []model.TaskStatus{model.TaskTodo, model.TaskInProgress, model.TaskDone, model.TaskDone} {
		var deleted any
		if index == 3 {
			deleted = stamp.Add(2 * time.Hour)
		}
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,started_at,completed_at,allow_agents,required_platform,deleted_at)
			VALUES($1,$2,'Assignment history','Preserved',$3,9007199254740993,$4,$5,$4,$5,true,'linux',$6)`, queryID(index+10), project.ID, status, stamp, stamp.Add(time.Hour), deleted)
		mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests','[{"url":"opaque\\u0000","title":"Evidence"}]'),($1,'paused','false')`, queryID(index+10))
	}
	mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'worker',$2)`, queryID(11), legacyPropertiesWorkerAssignmentFixture(t))
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, project.ID, queryID(12), queryID(10))
	mustQueryExec(t, database, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,'evidence.md','text/markdown',123)`, project.ID, queryID(12))
	mustQueryExec(t, database, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}','{"lifecycle":"active"}')`, queryID(100), project.ID, queryID(11), queryID(101), queryID(102), queryID(103))
	mustQueryExec(t, database, `INSERT INTO session_events(session_id,event_seq,event) VALUES($1,1,'{"kind":"preserved"}')`, queryID(100))
	mustQueryExec(t, database, `INSERT INTO session_archives(session_id,state) VALUES($1,'pending')`, queryID(100))
	facts := func() map[string]string {
		t.Helper()
		result := map[string]string{}
		for table, query := range map[string]string{
			"tasks":           `SELECT coalesce(jsonb_agg(to_jsonb(t)-'assigned_to' ORDER BY id),'[]'::jsonb)::text FROM tasks t`,
			"properties":      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY task_id,name),'[]'::jsonb)::text FROM task_properties t`,
			"dependencies":    `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY task_id,depends_on_task_id),'[]'::jsonb)::text FROM task_dependencies t`,
			"attachments":     `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY task_id,path),'[]'::jsonb)::text FROM task_attachments t`,
			"sessions":        `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb)::text FROM task_sessions t`,
			"events":          `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY session_id,event_seq),'[]'::jsonb)::text FROM session_events t`,
			"archives":        `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY session_id),'[]'::jsonb)::text FROM session_archives t`,
			"existing ledger": `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY version),'[]'::jsonb)::text FROM schema_migrations t WHERE version<=27`,
		} {
			var value string
			if err := pool.QueryRow(ctx, query).Scan(&value); err != nil {
				t.Fatal(err)
			}
			result[table] = value
		}
		return result
	}
	before := facts()
	if err := migrate(ctx, pool, schemaMigrations[:28]); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, facts()) {
		t.Fatal("assignment migration changed historical task, execution or content facts")
	}
	var assigned, unassigned int
	if err := pool.QueryRow(ctx, `SELECT count(*) FILTER(WHERE assigned_to IS NOT NULL),count(*) FILTER(WHERE assigned_to IS NULL) FROM tasks`).Scan(&assigned, &unassigned); err != nil || assigned != 0 || unassigned != 4 {
		t.Fatalf("existing tasks acquired an inferred assignee: assigned=%d unassigned=%d err=%v", assigned, unassigned, err)
	}
	var indexDefinition string
	if err := pool.QueryRow(ctx, `SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid='tasks'::regclass AND pg_get_indexdef(indexrelid) LIKE '%(project_id, assigned_to, created_at, id)%'`).Scan(&indexDefinition); err != nil || !strings.Contains(indexDefinition, "deleted_at IS NULL") {
		t.Fatalf("missing scoped assignment index: %q, %v", indexDefinition, err)
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Unassigned new task')`, queryID(20), project.ID)
	var defaultAssigned *string
	if err := pool.QueryRow(ctx, `SELECT assigned_to::text FROM tasks WHERE id=$1`, queryID(20)).Scan(&defaultAssigned); err != nil || defaultAssigned != nil {
		t.Fatalf("default assignment: %v, %v", defaultAssigned, err)
	}
	_, err := pool.Exec(ctx, `UPDATE tasks SET assigned_to='not-a-uuid' WHERE id=$1`, queryID(20))
	var invalid *pgconn.PgError
	if !errors.As(err, &invalid) || invalid.Code != "22P02" {
		t.Fatalf("non-UUID assignment bypassed native type: %v", err)
	}
	var applied, repeated time.Time
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=28`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:28]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=28`).Scan(&repeated); err != nil || !applied.Equal(repeated) {
		t.Fatalf("repeated assignment migration changed its receipt: %v", err)
	}
}

func legacyPropertiesWorkerAssignmentFixture(t *testing.T) string {
	t.Helper()
	raw, err := json.Marshal(legacyWorker026Fixture())
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestTaskAssignmentAllIndexMigration(t *testing.T) {
	pool := emptyPool(t)
	ctx := t.Context()
	if err := migrate(ctx, pool, schemaMigrations[:62]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,assigned_to,deleted_at)
		VALUES($1,$3,'Visible',$4,NULL),($2,$3,'Deleted',$4,statement_timestamp())`,
		queryID(10), queryID(11), project.ID, queryID(20))
	var before string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t)-'ancestor_deleted_at' ORDER BY id)::text FROM tasks t`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	// An incomplete ledger write must roll back the index with the migration.
	mustQueryExec(t, database, `CREATE FUNCTION reject_assignment_index_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN IF NEW.version=63 THEN RAISE EXCEPTION USING ERRCODE='P1063', MESSAGE='ledger rejection'; END IF; RETURN NEW; END $$;
		CREATE TRIGGER reject_assignment_index_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION reject_assignment_index_ledger()`)
	err := migrate(ctx, pool, schemaMigrations)
	var cause *pgconn.PgError
	if !errors.As(err, &cause) || cause.Code != "P1063" {
		t.Fatalf("migration lost ledger failure: %v", err)
	}
	var newIndex *string
	var ledger int
	if err := pool.QueryRow(ctx, `SELECT to_regclass('tasks_project_assigned_to_created_id_all')::text,
		(SELECT count(*) FROM schema_migrations WHERE version=63)`).Scan(&newIndex, &ledger); err != nil || newIndex != nil || ledger != 0 {
		t.Fatalf("failed migration retained index or ledger: %v %d %v", newIndex, ledger, err)
	}
	mustQueryExec(t, database, `DROP TRIGGER reject_assignment_index_ledger ON schema_migrations; DROP FUNCTION reject_assignment_index_ledger()`)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatalf("migration failed after repairing cause: %v", err)
	}
	for name, predicate := range map[string]bool{
		"tasks_project_assigned_to_created_id":     true,
		"tasks_project_assigned_to_created_id_all": false,
	} {
		var definition string
		var hasPredicate bool
		if err := pool.QueryRow(ctx, `SELECT pg_get_indexdef(indexrelid), indpred IS NOT NULL
			FROM pg_index WHERE indexrelid=to_regclass($1) AND indrelid='tasks'::regclass AND indisvalid`, name).Scan(&definition, &hasPredicate); err != nil || hasPredicate != predicate || !strings.Contains(definition, "(project_id, assigned_to, created_at, id)") {
			t.Fatalf("index %s definition %q predicate %v: %v", name, definition, hasPredicate, err)
		}
	}
	var applied, repeated time.Time
	var after string
	if err := pool.QueryRow(ctx, `SELECT applied_at FROM schema_migrations WHERE version=63`).Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT (SELECT applied_at FROM schema_migrations WHERE version=63),
		(SELECT jsonb_agg(to_jsonb(t)-'ancestor_deleted_at' ORDER BY id)::text FROM tasks t)`).Scan(&repeated, &after); err != nil || !applied.Equal(repeated) || before != after {
		t.Fatalf("migration changed task facts or repeated ledger: %v", err)
	}
}

func taskBlockedMigrationIndex(t *testing.T) int {
	t.Helper()
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 87 })
	if index < 1 {
		t.Fatal("blocked property migration is missing")
	}
	return index
}

func TestTaskBlockedMigrationPreservesFactsAndHistory(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	index := taskBlockedMigrationIndex(t)
	migrations := schemaMigrations[:index+1]
	if err := migrate(ctx, pool, migrations[:index]); err != nil {
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
	if err := migrate(ctx, pool, migrations); err != nil {
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
	if err := migrate(ctx, pool, migrations); err != nil {
		t.Fatal(err)
	}
	var repeated string
	if err := pool.QueryRow(ctx, `SELECT applied_at::text FROM schema_migrations WHERE version=87`).Scan(&repeated); err != nil || repeated != applied || snapshot(false) != before {
		t.Fatalf("replay changed facts or ledger: %v", err)
	}
}

func TestTaskBlockedMigrationRejectsBadRowsAtomically(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	index := taskBlockedMigrationIndex(t)
	migrations := schemaMigrations[:index+1]
	if err := migrate(ctx, pool, migrations[:index]); err != nil {
		t.Fatal(err)
	}
	db := &Store{Pool: pool}
	project := queryProject(t, db, 1)
	for i := 0; i < 2; i++ {
		mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Task')`, queryID(i+10), project.ID)
	}
	mustQueryExec(t, db, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'paused','true')`, queryID(10))
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
		if !t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
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
			if err := migrate(ctx, pool, migrations); err == nil {
				t.Fatal("invalid data was accepted")
			}
			if err := pool.QueryRow(ctx, read).Scan(&after); err != nil || before != after {
				t.Fatalf("failed migration changed rows or ledger: before=%s after=%s err=%v", before, after, err)
			}
			mustQueryExec(t, db, `DELETE FROM task_properties WHERE task_id=$1 AND name=$2`, id, tc.property)
		}) {
			return
		}
	}
	if err := migrate(ctx, pool, migrations); err != nil {
		t.Fatalf("repaired migration: %v", err)
	}
}

func legacyWorker026Fixture() map[string]any {
	return map[string]any{
		"claimId": queryID(201), "state": "active", "userId": queryID(202), "workerId": queryID(203),
		"machine": map[string]any{"id": queryID(204), "name": "Machine"}, "platform": "linux", "agent": "codex",
		"agentControlMode": "herdr", "worktreeId": queryID(205), "phase": "executing",
		"herdr":           map[string]any{"session": "session", "workspaceId": "workspace", "paneId": "pane"},
		"nativeSessionId": "native", "claimedAt": "2026-10-24T01:02:03.123456Z",
	}
}

func legacyProperties026Fixture(t *testing.T, worker any) string {
	t.Helper()
	value, err := json.Marshal(map[string]any{"pullRequests": []any{map[string]any{"url": "\x00", "title": "Unicode 中文"}, map[string]any{"url": "same", "title": "duplicate"}, map[string]any{"url": "same", "title": "duplicate"}}, "worker": worker})
	if err != nil {
		t.Fatal(err)
	}
	return string(value)
}

func TestPropertyRowsMigrationPreservesValuesAndTaskFacts(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:25]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	expected := make(map[string]map[string]any)
	for i := 0; i < 105; i++ {
		var worker any
		if i%4 != 0 {
			w := legacyWorker026Fixture()
			w["state"] = []string{"active", "released", "completed"}[i%3]
			if i%5 == 0 {
				delete(w, "agentControlMode")
			}
			worker = w
		}
		raw := legacyProperties026Fixture(t, worker)
		if i == 0 {
			raw = `{"pullRequests":[],"worker":null}`
		}
		if i == 1 {
			raw = `{"pullRequests":[{"url":"\u0000","title":"\ud800"}],"worker":null}`
		}
		id := queryID(i + 10)
		var deleted any
		if i%7 == 0 {
			deleted = stamp.Add(time.Hour)
		}
		mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,description,status,version,created_at,updated_at,deleted_at,properties) VALUES($1,$2,'Migration','Body','todo',9007199254740993,$3,$4,$5,$6)`, id, project.ID, stamp, stamp.Add(time.Hour), deleted, raw)
		var values map[string]any
		if err := json.Unmarshal([]byte(raw), &values); err != nil {
			t.Fatal(err)
		}
		if values["worker"] == nil {
			delete(values, "worker")
		} else if worker := values["worker"].(map[string]any); worker["agentControlMode"] == nil {
			worker["agentControlMode"] = "herdr"
		}
		expected[id] = values
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t)-'properties' ORDER BY id)::text FROM tasks t`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:26]); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t`).Scan(&after); err != nil || before != after {
		t.Fatalf("parent task facts changed: %v", err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		ids := make([]string, 0, len(expected))
		for id := range expected {
			ids = append(ids, id)
		}
		actual, err := pg.LoadTaskProperties(ctx, snapshot.(*Snapshot).tx, ids)
		if err != nil {
			return err
		}
		for id, properties := range actual {
			values := make(map[string]any, len(properties))
			for key, raw := range properties {
				var value any
				if err := json.Unmarshal(raw, &value); err != nil {
					return err
				}
				values[key] = value
			}
			if !reflect.DeepEqual(values, expected[id]) {
				t.Fatalf("migration changed property values for %s: %#v", id, values)
			}
		}
		if len(actual) != len(expected) {
			t.Fatalf("migration lost tasks: got %d, want %d", len(actual), len(expected))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	var oldColumn bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='properties')`).Scan(&oldColumn); err != nil || oldColumn {
		t.Fatalf("old column retained: %v", err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:26]); err != nil {
		t.Fatal(err)
	}
	changed := append([]migration(nil), schemaMigrations[:26]...)
	changed[25].transformSource += "changed"
	if err := migrate(ctx, pool, changed); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("transform source is not checksummed: %v", err)
	}
}

func TestPropertyRowsMigrationRejectsInvalidInputAtomically(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:25]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	const good = `{"pullRequests":[],"worker":null}`
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,properties) VALUES($1,$2,'Good',$4),($3,$2,'Bad',$4)`, queryID(10), project.ID, queryID(20), good)
	source := func(t *testing.T) string {
		t.Helper()
		var facts string
		if err := pool.QueryRow(t.Context(), "SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM tasks t").Scan(&facts); err != nil {
			t.Fatal(err)
		}
		return facts
	}
	ledger := func(t *testing.T) string {
		t.Helper()
		var facts string
		if err := pool.QueryRow(t.Context(), "SELECT jsonb_agg(to_jsonb(m) ORDER BY version)::text FROM schema_migrations m").Scan(&facts); err != nil {
			t.Fatal(err)
		}
		return facts
	}
	original, originalLedger := source(t), ledger(t)
	for _, bad := range []string{`{"pullRequests":[],"worker":null,"unknown":0}`, `{"pullRequests":null,"worker":null}`, `{"pullRequests":[],"worker":null,"worker":null}`, `{"pullRequests":[]}`, `{"pullRequests":[],"worker":{}}`} {
		if !t.Run(bad, func(t *testing.T) {
			if original != source(t) || originalLedger != ledger(t) {
				t.Fatal("previous failure changed the historical property fixture")
			}
			mustQueryExec(t, database, "UPDATE tasks SET properties=$2 WHERE id=$1", queryID(20), bad)
			var stored string
			if err := pool.QueryRow(t.Context(), "SELECT properties FROM tasks WHERE id=$1", queryID(20)).Scan(&stored); err != nil || stored != bad {
				t.Fatalf("invalid legacy input bytes changed: %q %v", stored, err)
			}
			before := source(t)
			migrations := append([]migration(nil), schemaMigrations...)
			if err := migrate(ctx, pool, migrations); err == nil {
				t.Fatal("invalid legacy value migrated")
			}
			var table, oldColumn bool
			var count int
			if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name='task_properties'),EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='tasks' AND column_name='properties')`).Scan(&table, &oldColumn); err != nil || table || !oldColumn {
				t.Fatalf("partial schema retained: %v", err)
			}
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM schema_migrations WHERE version=26`).Scan(&count); err != nil || count != 0 {
				t.Fatalf("failed migration ledger retained: %v", err)
			}
			if before != source(t) || originalLedger != ledger(t) {
				t.Fatal("failed property migration changed original source rows or ledger")
			}
			assertMigrationPoolReusable(t, pool)
			mustQueryExec(t, database, "UPDATE tasks SET properties=$2 WHERE id=$1", queryID(20), good)
			if original != source(t) || originalLedger != ledger(t) {
				t.Fatal("historical property fixture was not restored exactly")
			}
		}) {
			return
		}
	}
}

func TestPropertyRowsMigrationLedgerFailureRollsBack(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:25]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := queryProject(t, database, 1)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Ledger')`, queryID(10), project.ID)
	mustQueryExec(t, database, `CREATE FUNCTION refuse_property_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.version=26 THEN RAISE EXCEPTION USING ERRCODE='P1026', MESSAGE='ledger refusal'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_property_ledger BEFORE INSERT ON schema_migrations FOR EACH ROW EXECUTE FUNCTION refuse_property_ledger()`)
	err := migrate(ctx, pool, schemaMigrations)
	var pg *pgconn.PgError
	if !errors.As(err, &pg) || pg.Code != "P1026" {
		t.Fatalf("ledger cause lost: %v", err)
	}
	var raw string
	if err := pool.QueryRow(ctx, `SELECT properties FROM tasks WHERE id=$1`, queryID(10)).Scan(&raw); err != nil || raw != `{"pullRequests":[],"worker":null}` {
		t.Fatalf("legacy task changed: %v", err)
	}
	mustQueryExec(t, database, `DROP TRIGGER refuse_property_ledger ON schema_migrations; DROP FUNCTION refuse_property_ledger()`)
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
}

func TestPropertyRowsWritesAreAtomicWithTaskMetadata(t *testing.T) {
	parallelRootDatabaseTest(t)
	ctx := context.Background()
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskTodo)
	properties := model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"opaque","title":"PR"}]`)}
	for _, table := range []string{"tasks", "task_properties"} {
		mustQueryExec(t, database, `CREATE FUNCTION refuse_property_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'property transaction refusal'; END $$; CREATE TRIGGER refuse_property_write BEFORE INSERT OR UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION refuse_property_write()`)
		err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: "Changed", Status: model.TaskTodo, Properties: properties})
			return err
		})
		if err == nil {
			t.Fatal("failed write succeeded")
		}
		actual := snapshotTask(t, database, project.ID, task.ID)
		if !reflect.DeepEqual(actual, task) {
			t.Fatalf("partial task/property commit: %#v", actual)
		}
		mustQueryExec(t, database, `DROP TRIGGER refuse_property_write ON `+table+`; DROP FUNCTION refuse_property_write()`)
	}
	if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
		_, err := tx.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: "Changed", Status: model.TaskTodo, Properties: properties})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	actual := snapshotTask(t, database, project.ID, task.ID)
	if actual.Version != task.Version+1 || len(actual.Properties) != 1 {
		t.Fatalf("successful property write missing: %#v", actual)
	}
	if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
		_, err := tx.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: actual.Title, Status: actual.Status, Properties: model.TaskProperties{}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if actual = snapshotTask(t, database, project.ID, task.ID); len(actual.Properties) != 0 {
		t.Fatalf("property deletion left a default: %#v", actual.Properties)
	}
}
