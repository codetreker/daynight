package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
)

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

func TestTaskStorageDefaultsAndConstraints(t *testing.T) {
	parallelRootDatabaseTest(t)
	ctx := t.Context()
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	id := queryID(10)
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'Default task')`, id, project.ID)
	task := snapshotTask(t, database, project.ID, id)
	if task.Status != model.TaskProposed || task.Type != model.TaskTypeTask || task.Ready || task.Version != 1 ||
		task.AllowAgents || task.ParentID != nil || task.AssignedTo != nil || task.RequiredPlatform != nil ||
		task.StartedAt != nil || task.CompletedAt != nil || task.CancelledAt != nil ||
		!task.CreatedAt.Equal(task.UpdatedAt) || fixtureWorker(t, task.Properties) != nil {
		t.Fatalf("new task defaults: %#v", task)
	}
	if len(task.Properties) != 0 {
		t.Fatalf("new task unexpectedly has persisted properties: %#v", task.Properties)
	}
	mustQueryExec(t, database, `INSERT INTO tasks(id,project_id,title,status) VALUES($1,$2,'Confirmed todo','todo')`, queryID(11), project.ID)
	if todo := snapshotTask(t, database, project.ID, queryID(11)); todo.Status != model.TaskTodo || !todo.Ready {
		t.Fatalf("explicit todo lost executable status: %#v", todo)
	}

	for _, test := range []struct {
		set  string
		code string
	}{
		{"allow_agents=NULL", "23502"},
		{"assigned_to='not-a-uuid'", "22P02"},
		{"status='cancelled'", "23514"},
		{"cancelled_at=statement_timestamp()", "23514"},
		{"status='cancel',cancelled_at=statement_timestamp()", "23514"},
	} {
		_, err := database.Pool.Exec(ctx, "UPDATE tasks SET "+test.set+" WHERE id=$1", id)
		var constraint *pgconn.PgError
		if !errors.As(err, &constraint) || constraint.Code != test.code {
			t.Fatalf("invalid task mutation %s: %v", test.set, err)
		}
	}
	mustQueryExec(t, database, `UPDATE tasks SET status='cancelled',cancelled_at=statement_timestamp() WHERE id=$1`, id)
	if cancelled := snapshotTask(t, database, project.ID, id); cancelled.Status != model.TaskCancelled || cancelled.CancelledAt == nil {
		t.Fatalf("valid cancellation not read back: %#v", cancelled)
	}
	for _, platform := range []string{"windows", "linux", "macos", "", "darwin", "Windows"} {
		_, err := database.Pool.Exec(ctx, `UPDATE tasks SET required_platform=$1 WHERE id=$2`, platform, id)
		if model.TaskPlatform(platform).Valid() {
			if err != nil {
				t.Fatalf("valid platform %q: %v", platform, err)
			}
			if got := snapshotTask(t, database, project.ID, id).RequiredPlatform; got == nil || string(*got) != platform {
				t.Fatalf("platform %q not read back: %v", platform, got)
			}
			continue
		}
		var constraint *pgconn.PgError
		if !errors.As(err, &constraint) || constraint.Code != "23514" {
			t.Fatalf("invalid platform %q: %v", platform, err)
		}
	}
	mustQueryExec(t, database, `UPDATE tasks SET required_platform=NULL WHERE id=$1`, id)
	if platform := snapshotTask(t, database, project.ID, id).RequiredPlatform; platform != nil {
		t.Fatalf("NULL platform not read back: %s", *platform)
	}
}

func TestTaskStorageAssignmentAndHierarchyIndexes(t *testing.T) {
	parallelRootDatabaseTest(t)
	ctx := t.Context()
	pool := isolatedStore(t).Pool
	for _, test := range []struct {
		name      string
		keys      string
		predicate string
	}{
		{"tasks_project_assigned_to_created_id", "(project_id, assigned_to, created_at, id)", "deleted_at IS NULL"},
		{"tasks_project_assigned_to_created_id_all", "(project_id, assigned_to, created_at, id)", ""},
		{"tasks_project_type_created_id", "(project_id, type, created_at, id)", ""},
		{"tasks_project_parent_created_id", "(project_id, parent_id, created_at, id)", ""},
	} {
		var definition, predicate string
		err := pool.QueryRow(ctx, `SELECT pg_get_indexdef(indexrelid), coalesce(pg_get_expr(indpred, indrelid, true), '')
			FROM pg_index WHERE indexrelid=to_regclass($1) AND indrelid='tasks'::regclass AND indisvalid`, test.name).Scan(&definition, &predicate)
		if err != nil || !strings.Contains(definition, test.keys) || predicate != test.predicate {
			t.Fatalf("index %s definition %q predicate %q: %v", test.name, definition, predicate, err)
		}
	}
}
