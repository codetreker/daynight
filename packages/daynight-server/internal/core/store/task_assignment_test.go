package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5/pgconn"
)

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
