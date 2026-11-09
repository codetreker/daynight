package postgres

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type syncPropertiesQueryKey struct{}

type syncPropertiesTracer struct {
	taskQueries     int
	propertyQueries int
	afterTasks      func()
}

func (tracer *syncPropertiesTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "left(t.title, $2)") {
		tracer.taskQueries++
		return context.WithValue(ctx, syncPropertiesQueryKey{}, true)
	}
	if strings.Contains(data.SQL, "FROM task_properties") {
		tracer.propertyQueries++
	}
	return ctx
}

func (tracer *syncPropertiesTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if matched, _ := ctx.Value(syncPropertiesQueryKey{}).(bool); matched && tracer.afterTasks != nil {
		action := tracer.afterTasks
		tracer.afterTasks = nil
		action()
	}
}

func TestTaskSyncPropertiesShareTaskSnapshotAndBatchQueries(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx := context.Background()
	project := queryProject(t, database, 1)
	other := queryProject(t, database, 2)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	empty := queryTask(t, database, project.ID, 11, model.TaskTodo)
	foreign := queryTask(t, database, other.ID, 12, model.TaskTodo)
	before, err := taskproperties.Normalize(model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"opaque\u0000","title":"Repeated 中文"},{"url":"opaque\u0000","title":"Repeated 中文"}]`)})
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2),($3,'unknown','null')`, task.ID, string(before["pullRequests"]), foreign.ID)
	tracer := &syncPropertiesTracer{afterTasks: func() {
		if err := writeProjectForTest(database, ctx, project.ID, func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().UpdateTask(ctx, task.ID, TaskWrite{Title: task.Title, Description: task.Description, Status: task.Status, Properties: model.TaskProperties{}})
			return err
		}); err != nil {
			t.Fatal(err)
		}
	}}
	config := database.Pool.Config()
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	traced := &Store{Pool: pool}
	if err := traced.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		actual, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil {
			return err
		}
		if len(actual) != 2 || actual[0].ID != task.ID || actual[0].Version != task.Version || !reflect.DeepEqual(actual[0].Properties, before) ||
			actual[1].ID != empty.ID || actual[1].Properties == nil || len(actual[1].Properties) != 0 {
			t.Fatalf("task and property snapshots diverged: %#v", actual)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		actual, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
		if err != nil {
			return err
		}
		if len(actual) != 2 || actual[0].Version != task.Version+1 || actual[0].Properties == nil || len(actual[0].Properties) != 0 {
			t.Fatalf("fresh snapshot missed property deletion: %#v", actual)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}
