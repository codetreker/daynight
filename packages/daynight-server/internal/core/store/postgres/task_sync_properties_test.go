package postgres

import (
	"context"
	"encoding/json"
	"errors"
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

func TestTaskSyncPropertiesShareTaskSnapshotAndBoundedQueries(t *testing.T) {
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
	if tracer.taskQueries != 1 || tracer.propertyQueries != 3 {
		t.Fatalf("properties were not loaded per task: task=%d properties=%d", tracer.taskQueries, tracer.propertyQueries)
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
	future := task.UpdatedAt.AddDate(100, 0, 0)
	if err := traced.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		actual, err := snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, &future, 160)
		if err != nil || actual == nil || len(actual) != 0 {
			t.Fatalf("empty window changed: %#v %v", actual, err)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if tracer.taskQueries != 2 || tracer.propertyQueries != 3 {
		t.Fatalf("empty window queried properties: task=%d properties=%d", tracer.taskQueries, tracer.propertyQueries)
	}
}

func TestTaskSyncPropertyFailuresReturnNoPartialRows(t *testing.T) {
	for _, test := range []struct{ name, field, raw string }{
		{"unknown", "unknown", `[]`}, {"invalid JSON", "pullRequests", `[`}, {"invalid shape", "pullRequests", `null`},
	} {
		t.Run(test.name, func(t *testing.T) {
			database := isolatedStore(t)
			ctx := context.Background()
			project := queryProject(t, database, 1)
			queryTask(t, database, project.ID, 10, model.TaskTodo)
			bad := queryTask(t, database, project.ID, 11, model.TaskTodo)
			mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,$2,$3)`, bad.ID, test.field, test.raw)
			var actual []model.TaskViewRecord
			err := database.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
				var err error
				actual, err = snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
				return err
			})
			var invalid *taskproperties.ValidationError
			if !errors.As(err, &invalid) || actual != nil {
				t.Fatalf("bad property lost cause or returned partial tasks: %#v %v", actual, err)
			}
		})
	}
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	queryTask(t, database, project.ID, 10, model.TaskTodo)
	mustQueryExec(t, database, `DROP TABLE task_properties`)
	err := database.ReadSnapshot(context.Background(), func(snapshot SnapshotScope) error {
		actual, err := snapshot.TaskDAO().TaskSyncTasks(context.Background(), project.ID, nil, 160)
		if actual != nil {
			t.Fatalf("property query failure returned tasks: %#v", actual)
		}
		return err
	})
	var invalid *taskproperties.ValidationError
	if err == nil || errors.As(err, &invalid) {
		t.Fatalf("database failure became a property refusal: %v", err)
	}
}

type cancelPropertyChunkTracer struct {
	cancel context.CancelFunc
	chunks int
}
type propertyChunkTraceKey struct{}

func (tracer *cancelPropertyChunkTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "substring(value FROM") {
		return context.WithValue(ctx, propertyChunkTraceKey{}, true)
	}
	return ctx
}
func (tracer *cancelPropertyChunkTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if hit, _ := ctx.Value(propertyChunkTraceKey{}).(bool); hit {
		tracer.chunks++
		if tracer.chunks == 1 {
			tracer.cancel()
		}
	}
}

func TestTaskSyncPropertyChunkReadHonorsCancellation(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	item := queryTask(t, database, project.ID, 10, model.TaskTodo)
	value := `[{"url":"` + strings.Repeat("x", 200000) + `","title":""}]`
	mustQueryExec(t, database, `INSERT INTO task_properties(task_id,name,value) VALUES($1,'pullRequests',$2)`, item.ID, value)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	tracer := &cancelPropertyChunkTracer{cancel: cancel}
	config := database.Pool.Config()
	config.ConnConfig.Tracer = tracer
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	traced := &Store{Pool: pool}
	var result []model.TaskViewRecord
	err = traced.ReadSnapshot(ctx, func(snapshot SnapshotScope) error {
		var e error
		result, e = snapshot.TaskDAO().TaskSyncTasks(ctx, project.ID, nil, 160)
		return e
	})
	if !errors.Is(err, context.Canceled) || len(result) != 0 || tracer.chunks < 1 || tracer.chunks > 2 {
		t.Fatalf("result=%d chunks=%d error=%v", len(result), tracer.chunks, err)
	}
}
