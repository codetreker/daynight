package store

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestTaskProposedMigrationPreservesExistingResourcesAndDefault(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:6]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := projectBeforeSettings(t, database, 1)
	created := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	updated := created.Add(time.Hour)
	before := make([]core.Task, 0, 3)
	for index, status := range []core.TaskStatus{core.TaskTodo, core.TaskInProgress, core.TaskDone} {
		id := queryID(index + 10)
		mustQueryExec(t, database, `INSERT INTO tasks (id, project_id, title, description, status, version, created_at, updated_at)
			VALUES ($1, $2, 'Existing task', 'Existing description', $3, $4, $5, $6)`, id, project.ID, status, index+17, created, updated)
		before = append(before, snapshotTaskBeforeTiming(t, database, project.ID, id))
	}
	_, err := pool.Exec(ctx, `INSERT INTO tasks (id, project_id, title, status) VALUES ($1, $2, 'Proposed', 'proposed')`, queryID(20), project.ID)
	var constraint *pgconn.PgError
	if !errors.As(err, &constraint) || constraint.Code != "23514" {
		t.Fatalf("old schema did not reject proposed: %v", err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:7]); err != nil {
		t.Fatal(err)
	}
	for _, original := range before {
		if after := snapshotTaskBeforeTiming(t, database, project.ID, original.ID); !reflect.DeepEqual(after, original) {
			t.Fatalf("migration changed existing resource: %#v versus %#v", after, original)
		}
	}
	mustQueryExec(t, database, `INSERT INTO tasks (id, project_id, title, status) VALUES ($1, $2, 'Proposed', 'proposed')`, queryID(20), project.ID)
	mustQueryExec(t, database, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id) VALUES ($1, $2, $3)`, project.ID, queryID(20), before[0].ID)
	proposed := snapshotTaskBeforeTiming(t, database, project.ID, queryID(20))
	if proposed.Status != core.TaskStatus("proposed") || proposed.Ready || !slices.Equal(proposed.BlockedBy, []string{before[0].ID}) {
		t.Fatalf("migrated proposed resource: %#v", proposed)
	}
	mustQueryExec(t, database, `INSERT INTO tasks (id, project_id, title) VALUES ($1, $2, 'Default')`, queryID(21), project.ID)
	if task := snapshotTaskBeforeTiming(t, database, project.ID, queryID(21)); task.Status != core.TaskTodo || !task.Ready {
		t.Fatalf("migration changed database creation default: %#v", task)
	}
	var applied time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=7").Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:7]); err != nil {
		t.Fatal(err)
	}
	var after time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=7").Scan(&after); err != nil || !after.Equal(applied) || !reflect.DeepEqual(snapshotTaskBeforeTiming(t, database, project.ID, proposed.ID), proposed) {
		t.Fatalf("repeated migration changed ledger/resource: %v, %v", after, err)
	}
}

func TestTaskTodoGetPaginationAndReadiness(t *testing.T) {
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	pending := queryTask(t, database, project.ID, 10, core.TaskTodo)
	done := queryTask(t, database, project.ID, 11, core.TaskDone)
	unblocked := queryTask(t, database, project.ID, 12, core.TaskTodo, done.ID)
	blocked := queryTask(t, database, project.ID, 13, core.TaskTodo, pending.ID)
	dependent := queryTask(t, database, project.ID, 14, core.TaskTodo, unblocked.ID)
	if err := database.ReadSnapshot(ctx, func(snapshot *Snapshot) error {
		for _, task := range []core.Task{unblocked, blocked} {
			read, err := snapshot.Task(ctx, project.ID, task.ID)
			if err != nil || !reflect.DeepEqual(read, task) || read.Ready != (task.ID == unblocked.ID) {
				t.Fatalf("todo GET projection: %#v, %v", read, err)
			}
		}
		if len(unblocked.BlockedBy) != 0 || !slices.Equal(blocked.BlockedBy, []string{pending.ID}) || !slices.Equal(dependent.BlockedBy, []string{unblocked.ID}) || dependent.Ready {
			t.Fatalf("todo dependency projection: %#v, %#v, %#v", unblocked, blocked, dependent)
		}
		page := Page{Limit: 2}
		var listed []string
		for {
			result, err := snapshot.Tasks(ctx, project.ID, TaskQuery{Page: page})
			if err != nil {
				return err
			}
			for _, task := range result.Items {
				listed = append(listed, task.ID)
			}
			if !result.HasMore {
				break
			}
			last := result.Items[len(result.Items)-1]
			page.After = &Position{CreatedAt: last.CreatedAt, ID: last.ID}
		}
		if !slices.Equal(listed, []string{pending.ID, done.ID, unblocked.ID, blocked.ID, dependent.ID}) {
			t.Fatalf("paginated inventory omitted todo: %#v", listed)
		}
		ready := true
		result, err := snapshot.Tasks(ctx, project.ID, TaskQuery{Page: Page{Limit: 10}, Ready: &ready})
		if err != nil || len(result.Items) != 2 || result.Items[0].ID != pending.ID || result.Items[1].ID != unblocked.ID {
			t.Fatalf("todo readiness did not match prerequisites: %#v, %v", result, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestTaskProposedDefaultMigrationPreservesExistingResources(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:7]); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	project := projectBeforeSettings(t, database, 1)
	stamp := time.Date(2026, 1, 2, 3, 4, 5, 123456000, time.UTC)
	var before []core.Task
	for index, status := range []core.TaskStatus{core.TaskStatus("proposed"), core.TaskTodo, core.TaskInProgress, core.TaskDone} {
		id := queryID(index + 10)
		mustQueryExec(t, database, `INSERT INTO tasks (id, project_id, title, description, status, version, created_at, updated_at)
			VALUES ($1, $2, 'Existing task', 'Existing description', $3, $4, $5, $6)`, id, project.ID, status, index+17, stamp, stamp.Add(time.Hour))
		before = append(before, snapshotTaskBeforeTiming(t, database, project.ID, id))
	}
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	for _, original := range before {
		if after := snapshotHistoricalTask(t, database, project.ID, original.ID); !reflect.DeepEqual(after, original) {
			t.Fatalf("default migration changed existing resource: %#v versus %#v", after, original)
		}
	}
	mustQueryExec(t, database, `INSERT INTO tasks (id, project_id, title) VALUES ($1, $2, 'Default')`, queryID(21), project.ID)
	created := snapshotHistoricalTask(t, database, project.ID, queryID(21))
	if created.Status != core.TaskStatus("proposed") || created.Ready || created.Version != 1 || !created.CreatedAt.Equal(created.UpdatedAt) {
		t.Fatalf("database default did not create proposed task: %#v", created)
	}
	var applied time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=8").Scan(&applied); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:12]); err != nil {
		t.Fatal(err)
	}
	var after time.Time
	if err := pool.QueryRow(ctx, "SELECT applied_at FROM schema_migrations WHERE version=8").Scan(&after); err != nil || !after.Equal(applied) || !reflect.DeepEqual(snapshotHistoricalTask(t, database, project.ID, created.ID), created) {
		t.Fatalf("repeated default migration changed ledger/resource: %v, %v", after, err)
	}
}

// Pre-timing rows have unknown execution intervals and gain the explicit legacy permission during migration.
func snapshotTaskBeforeTiming(t *testing.T, database *Store, projectID, id string) core.Task {
	t.Helper()
	task, err := scanHistoricalTask(database.Pool.QueryRow(context.Background(), `SELECT
		t.id::text, t.project_id::text, t.title, t.description, t.status, t.version,
		t.created_at, t.updated_at, NULL::timestamptz, NULL::timestamptz, true, NULL::text, t.properties, `+
		taskDependsOn+`, ARRAY[]::text[], `+taskBlockedBy+`, `+taskReady+`
		FROM tasks t WHERE t.project_id = $1 AND t.id = $2`, projectID, id))
	if err != nil {
		t.Fatal(err)
	}
	return task
}

// Historical migration assertions decode the schema they own without accepting legacy states at runtime.
func scanHistoricalTask(row pgx.Row) (core.Task, error) {
	var task core.Task
	var properties string
	err := row.Scan(&task.ID, &task.ProjectID, &task.Title, &task.Description, &task.Status,
		&task.Version, &task.CreatedAt, &task.UpdatedAt, &task.StartedAt, &task.CompletedAt, &task.AllowAgents, &task.RequiredPlatform, &properties, &task.DependsOn, &task.ExternalDependsOn, &task.BlockedBy, &task.Ready)
	if err != nil {
		return core.Task{}, err
	}
	var fields map[string]json.RawMessage
	if err = json.Unmarshal([]byte(properties), &fields); err != nil {
		return core.Task{}, err
	}
	if _, current := fields["worker"]; current {
		task.Properties, err = taskproperties.Decode([]byte(properties))
	} else {
		var patch core.TaskPropertiesPatch
		patch, err = taskproperties.DecodePatch([]byte(properties))
		if err == nil && patch.PullRequests != nil {
			task.Properties = core.TaskProperties{PullRequests: *patch.PullRequests}
		}
	}
	task.CreatedAt, task.UpdatedAt = task.CreatedAt.UTC(), task.UpdatedAt.UTC()
	task.StartedAt, task.CompletedAt = utcTime(task.StartedAt), utcTime(task.CompletedAt)
	return task, err
}

const historicalTaskProjection = `t.id::text, t.project_id::text, t.title, t.description,
 t.status, t.version, t.created_at, t.updated_at, t.started_at, t.completed_at, t.allow_agents, NULL::text, t.properties, ` + taskDependsOn + `, ` + taskExternalDependsOn + `, ` + taskBlockedBy + `, ` + taskReady

func snapshotHistoricalTask(t *testing.T, database *Store, projectID, id string) core.Task {
	t.Helper()
	task, err := scanHistoricalTask(database.Pool.QueryRow(context.Background(), `SELECT `+historicalTaskProjection+` FROM tasks t WHERE t.project_id=$1 AND t.id=$2`, projectID, id))
	if err != nil {
		t.Fatal(err)
	}
	return task
}
