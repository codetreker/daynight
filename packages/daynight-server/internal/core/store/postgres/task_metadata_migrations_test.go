package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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
		pg.TaskDependsOn+`,ARRAY[]::text[],`+pg.TaskBlockedBy+`,`+historicalTaskReady+` FROM tasks t WHERE t.project_id=$1 AND t.id=$2`, projectID, id))
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
