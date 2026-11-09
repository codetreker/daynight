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
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type taskPropertyQueryKey struct{}

type taskPropertyQueryAction struct {
	match func(string) bool
	end   func()
}

func (action taskPropertyQueryAction) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, taskPropertyQueryKey{}, action.match(data.SQL))
}

func (action taskPropertyQueryAction) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	if ctx.Value(taskPropertyQueryKey{}) == true {
		action.end()
	}
}

func taskPropertyTracedStore(t *testing.T, database *Store, action taskPropertyQueryAction) *Store {
	t.Helper()
	config := database.Pool.Config()
	config.ConnConfig.Tracer = action
	pool, err := pgxpool.NewWithConfig(context.Background(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return &Store{Pool: pool}
}

func taskPropertyWriteValues(task model.Task) TaskWrite { return testutil.TaskWrite(task) }

func taskPropertyFacts(t *testing.T, database *Store) map[string]string {
	t.Helper()
	facts := currentTaskFactsFixture(t, database)
	var edges string
	if err := database.Pool.QueryRow(context.Background(), `SELECT coalesce(jsonb_agg(to_jsonb(d) ORDER BY project_id,task_id,depends_on_task_id),'[]'::jsonb)::text FROM task_dependencies d`).Scan(&edges); err != nil {
		t.Fatal(err)
	}
	facts["dependencies"] = edges
	return facts
}

func TestTaskPropertiesPartialWritesRollBackMetadataAndEdges(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	old := queryTask(t, database, project.ID, 2, model.TaskDone)
	prerequisite := queryTask(t, database, project.ID, 3, model.TaskDone)
	target := queryTask(t, database, project.ID, 4, model.TaskInProgress, old.ID)
	putTaskPropertyFixture(t, database, target.ID, "pullRequests", []byte(`[{"url":"old\u0000","title":"Old"}]`))
	target = snapshotTask(t, database, project.ID, target.ID)
	before := taskPropertyFacts(t, database)
	values := taskPropertyWriteValues(target)
	values.Title, values.Description = "Changed", "Changed"
	values.DependsOn = []string{prerequisite.ID}
	values.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"changed\u0000","title":"Changed"}]`)}
	for _, fragment := range []string{"UPDATE tasks SET", "INSERT INTO task_dependencies"} {
		t.Run("cancel after "+fragment, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			traced := taskPropertyTracedStore(t, database, taskPropertyQueryAction{
				match: func(sql string) bool { return strings.Contains(sql, fragment) }, end: cancel,
			})
			completion, err := traced.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
				_, err := scope.TaskDAO().UpdateTask(ctx, target.ID, values)
				return err
			})
			if !errors.Is(err, context.Canceled) || completion.Outcome == TransactionCommitted {
				t.Fatalf("partial write cancellation lost its outcome or cause: %+v %v", completion, err)
			}
			if !reflect.DeepEqual(taskPropertyFacts(t, database), before) {
				t.Fatal("partial write persisted task fields, properties or dependency edges")
			}
		})
	}
	mustQueryExec(t, database, `CREATE FUNCTION reject_property_edge() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION USING ERRCODE='P1201',MESSAGE='private property edge failure'; END $$;
		CREATE TRIGGER reject_property_edge BEFORE INSERT ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_property_edge()`)
	for _, create := range []bool{false, true} {
		completion, err := database.WriteProject(context.Background(), project.ID, func(scope ProjectWriteScope) error {
			if create {
				_, err := scope.TaskDAO().CreateTask(context.Background(), queryID(5), values)
				return err
			}
			_, err := scope.TaskDAO().UpdateTask(context.Background(), target.ID, values)
			return err
		})
		var cause *pgconn.PgError
		if completion.Outcome != TransactionNotCommitted || !errors.As(err, &cause) || cause.Code != "P1201" {
			t.Fatalf("edge write failure lost confirmed rollback or SQL cause: %+v %v", completion, err)
		}
		if !reflect.DeepEqual(taskPropertyFacts(t, database), before) {
			t.Fatal("failed edge write persisted partial task or property state")
		}
	}
}

func TestTaskPropertiesReadSharesTaskSnapshot(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	target := queryTask(t, database, project.ID, 2, model.TaskTodo)
	putTaskPropertyFixture(t, database, target.ID, "pullRequests", []byte(`[{"url":"old","title":"Old"}]`))
	before := snapshotTask(t, database, project.ID, target.ID)
	updated := false
	traced := taskPropertyTracedStore(t, database, taskPropertyQueryAction{
		match: func(sql string) bool { return strings.Contains(sql, "SELECT t.id::text") },
		end: func() {
			if updated {
				return
			}
			updated = true
			values := taskPropertyWriteValues(before)
			values.Title = "New snapshot"
			values.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"new","title":"New"}]`)}
			if err := writeProjectForTest(database, context.Background(), project.ID, func(scope ProjectWriteScope) error {
				_, err := scope.TaskDAO().UpdateTask(context.Background(), target.ID, values)
				return err
			}); err != nil {
				t.Fatal(err)
			}
		},
	})
	actual := snapshotTask(t, traced, project.ID, target.ID)
	if !updated || !reflect.DeepEqual(actual, before) {
		t.Fatalf("task row and property read used different snapshots: %+v", actual)
	}
	after := snapshotTask(t, database, project.ID, target.ID)
	if after.Title != "New snapshot" || after.Version != before.Version+1 || string(after.Properties["pullRequests"]) != `[{"url":"new","title":"New"}]` {
		t.Fatalf("fresh snapshot missed the committed fields and properties: %+v", after)
	}
}

func TestTaskPropertyWritesPreserveWorkerAndRollback(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	target := queryTask(t, database, project.ID, 2, model.TaskTodo)
	worker := &model.WorkerClaim{ClaimID: queryID(3), State: model.WorkerActive, UserID: queryID(4), WorkerID: queryID(5),
		Machine: model.WorkerMachine{ID: queryID(6), Name: "Build"}, Platform: model.PlatformLinux,
		Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: queryID(7), Phase: model.WorkerPreparing, ClaimedAt: time.Now().UTC()}
	properties := fixtureTaskProperties(t, worker)
	values := taskPropertyWriteValues(target)
	values.Status, values.Properties, values.AllowAgents = model.TaskInProgress, properties, true
	if err := writeProjectForTest(database, context.Background(), project.ID, func(scope ProjectWriteScope) error {
		var err error
		target, err = scope.TaskDAO().UpdateTask(context.Background(), target.ID, values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if target.StartedAt == nil {
		t.Fatal("execution fixture did not record the actual start timestamp")
	}
	values = taskPropertyWriteValues(target)
	if err := writeProjectForTest(database, context.Background(), project.ID, func(scope ProjectWriteScope) error {
		_, err := scope.TaskDAO().UpdateTask(context.Background(), target.ID, values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	changed := snapshotTask(t, database, project.ID, target.ID)
	if !reflect.DeepEqual(fixtureWorker(t, changed.Properties), worker) || changed.Status != target.Status || !reflect.DeepEqual(changed.StartedAt, target.StartedAt) {
		t.Fatalf("property persistence changed execution state: %+v", changed)
	}
	before := taskPropertyFacts(t, database)
	mustQueryExec(t, database, `CREATE FUNCTION reject_property_value_write() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION USING ERRCODE='P1202',MESSAGE='private property write failure'; END $$;
		CREATE TRIGGER reject_property_value_write BEFORE INSERT OR UPDATE OR DELETE ON task_properties FOR EACH ROW EXECUTE FUNCTION reject_property_value_write()`)
	for _, remove := range []bool{false, true} {
		values := taskPropertyWriteValues(changed)
		values.Properties = fixtureTaskProperties(t, worker)
		if remove {
			delete(values.Properties, "pullRequests")
		} else {
			values.Properties["pullRequests"] = json.RawMessage(`[{"url":"new","title":"New"}]`)
		}
		completion, err := database.WriteProject(context.Background(), project.ID, func(scope ProjectWriteScope) error {
			_, err := scope.TaskDAO().UpdateTask(context.Background(), target.ID, values)
			return err
		})
		var cause *pgconn.PgError
		if completion.Outcome != TransactionNotCommitted || !errors.As(err, &cause) || cause.Code != "P1202" {
			t.Fatalf("property failure lost confirmed rollback or cause: %+v %v", completion, err)
		}
		if !reflect.DeepEqual(taskPropertyFacts(t, database), before) {
			t.Fatal("failed property set/remove persisted task or execution state")
		}
	}
}

func TestTaskResponseAdmissionRollsBackActualWrites(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	prerequisite := queryTask(t, database, project.ID, 2, model.TaskTodo)
	target := queryTask(t, database, project.ID, 3, model.TaskTodo)
	before := taskPropertyFacts(t, database)
	refused := errors.New("response admission refused after the DAO write")
	for _, create := range []bool{false, true} {
		completion, err := database.WriteProject(context.Background(), project.ID, func(scope ProjectWriteScope) error {
			values := taskPropertyWriteValues(target)
			values.Title, values.DependsOn = "Changed", []string{prerequisite.ID}
			values.Properties = model.TaskProperties{"pullRequests": json.RawMessage(`[{"url":"value","title":"Title"}]`)}
			if create {
				if _, err := scope.TaskDAO().CreateTask(context.Background(), queryID(4), values); err != nil {
					return err
				}
			} else if _, err := scope.TaskDAO().UpdateTask(context.Background(), target.ID, values); err != nil {
				return err
			}
			return refused
		})
		if completion.Outcome != TransactionNotCommitted || !errors.Is(err, refused) || !reflect.DeepEqual(taskPropertyFacts(t, database), before) {
			t.Fatalf("post-write response refusal lost rollback, cause or state: %+v %v", completion, err)
		}
	}
}
