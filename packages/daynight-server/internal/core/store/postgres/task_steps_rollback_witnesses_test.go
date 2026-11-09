package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var stepWitnessIDs = testutil.StepWitnessIDs

func seedStepWitnessRows(t *testing.T, database *Store, taskID string, count int) {
	t.Helper()
	testutil.SeedStepWitnessRows(t, database.Pool, taskID, count)
}

func stepWitnessState(t *testing.T, database *Store, taskID string, parentOnly bool) string {
	t.Helper()
	return testutil.StepWitnessState(t, database.Pool, taskID, parentOnly)
}

type stepWitnessHeader struct {
	model.TaskHeader
	UpdatedAt time.Time
}

func readStepWitnessRows(t *testing.T, database *Store, projectID, taskID string) (stepWitnessHeader, []model.TaskStep) {
	t.Helper()
	var header stepWitnessHeader
	var rows []model.TaskStep
	if err := database.ReadSnapshot(t.Context(), func(snapshot SnapshotScope) error {
		var err error
		header.TaskHeader, err = snapshot.TaskDAO().TaskHeader(t.Context(), projectID, taskID)
		if err != nil {
			return err
		}
		rows, err = snapshot.TaskDAO().TaskSteps(t.Context(), taskID)
		if err != nil {
			return err
		}
		if err := snapshot.(*Snapshot).tx.QueryRow(t.Context(), "SELECT updated_at FROM tasks WHERE id=$1", taskID).Scan(&header.UpdatedAt); err != nil {
			return err
		}
		header.UpdatedAt = header.UpdatedAt.UTC()
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return header, rows
}

func mutateStepWitness(ctx context.Context, dao TaskWriteDAO, taskID, operation string) error {
	return testutil.MutateStep(ctx, dao, taskID, operation)
}

type stepWriteCancelTracer struct {
	fragment string
	cancel   context.CancelFunc
	observed atomic.Bool
}

func (tracer *stepWriteCancelTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, tracer, strings.HasPrefix(data.SQL, tracer.fragment))
}

func (tracer *stepWriteCancelTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if ctx.Value(tracer) == true && data.Err == nil {
		tracer.observed.Store(true)
		tracer.cancel()
	}
}

func TestTaskStepsConfirmedRollbackAfterEachActualSQLWrite(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	seedStepWitnessRows(t, database, task.ID, 4)
	before := stepWitnessState(t, database, task.ID, false)
	for _, test := range []struct {
		operation string
		fragments []string
	}{
		{"add", []string{"UPDATE task_steps SET position=position+1", "INSERT INTO task_steps", "UPDATE tasks SET version=version+1,updated_at=$3"}},
		{"change", []string{"UPDATE task_steps SET title=", "UPDATE tasks SET version=version+1,updated_at=$3"}},
		{"status", []string{"UPDATE task_steps SET title=", "UPDATE tasks SET version=version+1,updated_at=$3"}},
		{"delete", []string{"DELETE FROM task_steps", "UPDATE task_steps SET position=position-1", "UPDATE tasks SET version=version+1,updated_at=$3"}},
		{"move", []string{"UPDATE task_steps SET position=CASE", "UPDATE tasks SET version=version+1,updated_at=$3"}},
	} {
		for _, fragment := range test.fragments {
			t.Run(test.operation+"/"+fragment, func(t *testing.T) {
				ctx, cancel := context.WithCancel(t.Context())
				defer cancel()
				tracer := &stepWriteCancelTracer{fragment: fragment, cancel: cancel}
				config := database.Pool.Config()
				config.ConnConfig.Tracer = tracer
				pool, err := pgxpool.NewWithConfig(t.Context(), config)
				if err != nil {
					t.Fatal(err)
				}
				defer pool.Close()
				traced := &Store{Pool: pool}
				completion, err := traced.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
					if _, err := scope.TaskDAO().TaskHeader(ctx, task.ID); err != nil {
						return err
					}
					return mutateStepWitness(ctx, scope.TaskDAO(), task.ID, test.operation)
				})
				var failure *TransactionError
				if !tracer.observed.Load() || !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || failure.CommitAttempted || failure.CleanupFailed || completion.Outcome != TransactionNotCommitted || failure.Outcome != TransactionNotCommitted {
					t.Fatalf("after-write cancellation: observed=%t completion=%+v transaction=%+v error=%v", tracer.observed.Load(), completion, failure, err)
				}
				if after := stepWitnessState(t, database, task.ID, false); after != before {
					t.Fatal("successful child or parent SQL survived rollback")
				}
			})
		}
	}
	assertMigrationPoolReusable(t, database.Pool)
}

func TestTaskStepsPartialWritesAndSuppressedRowsRollBack(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 10, model.TaskTodo)
	seedStepWitnessRows(t, database, task.ID, 4)
	before := stepWitnessState(t, database, task.ID, false)
	for _, test := range []struct {
		name, operation, trigger, table, event, body, sequence string
		suppressed                                             bool
	}{
		{"change/parent_touch", "change", "refuse_step_touch", "tasks", "BEFORE UPDATE", `RAISE EXCEPTION 'touch-failure-sentinel' USING ERRCODE='P0001';`, "", false},
		{"change/suppressed_target", "change", "suppress_step_update", "task_steps", "BEFORE UPDATE", `RETURN NULL;`, "", true},
		{"delete/partial_tail", "delete", "fail_delete_tail", "task_steps", "AFTER UPDATE", `IF nextval('delete_tail_attempts')=2 THEN RAISE EXCEPTION 'partial-tail-sentinel' USING ERRCODE='P0001'; END IF; RETURN NEW;`, "delete_tail_attempts", false},
		{"delete/parent_touch", "delete", "refuse_delete_touch", "tasks", "BEFORE UPDATE", `RAISE EXCEPTION 'delete-touch-sentinel' USING ERRCODE='P0001';`, "", false},
		{"delete/suppressed_target", "delete", "suppress_delete_target", "task_steps", "BEFORE DELETE", `RETURN NULL;`, "", true},
		{"delete/suppressed_tail", "delete", "suppress_delete_tail", "task_steps", "BEFORE UPDATE", `IF OLD.id='11111111' THEN RETURN NULL; END IF; RETURN NEW;`, "", true},
		{"move/partial_interval", "move", "fail_partial_move", "task_steps", "AFTER UPDATE", `IF nextval('move_attempts')=2 THEN RAISE EXCEPTION 'partial-move-sentinel' USING ERRCODE='P0001'; END IF; RETURN NEW;`, "move_attempts", false},
		{"move/parent_touch", "move", "refuse_move_touch", "tasks", "BEFORE UPDATE", `RAISE EXCEPTION 'move-touch-sentinel' USING ERRCODE='P0001';`, "", false},
		{"move/suppressed_interval", "move", "suppress_move_row", "task_steps", "BEFORE UPDATE", `IF OLD.id='11111111' THEN RETURN NULL; END IF; RETURN NEW;`, "", true},
	} {
		if !t.Run(test.name, func(t *testing.T) {
			if before != stepWitnessState(t, database, task.ID, false) {
				t.Fatal("previous fault changed the shared Step fixture")
			}
			if test.sequence != "" {
				mustQueryExec(t, database, "CREATE SEQUENCE "+pgx.Identifier{test.sequence}.Sanitize())
			}
			trigger := pgx.Identifier{test.trigger}.Sanitize()
			table := pgx.Identifier{test.table}.Sanitize()
			mustQueryExec(t, database, "CREATE FUNCTION "+trigger+"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN "+test.body+" END $$; CREATE TRIGGER "+trigger+" "+test.event+" ON "+table+" FOR EACH ROW EXECUTE FUNCTION "+trigger+"()")
			completion, err := database.WriteProject(t.Context(), project.ID, func(scope ProjectWriteScope) error {
				return mutateStepWitness(t.Context(), scope.TaskDAO(), task.ID, test.operation)
			})
			var failure *TransactionError
			if !errors.As(err, &failure) || failure.CommitAttempted || failure.CleanupFailed || completion.Outcome != TransactionNotCommitted || failure.Outcome != TransactionNotCommitted {
				t.Fatalf("partial SQL completion: %+v %+v %v", completion, failure, err)
			}
			if test.suppressed {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatal("suppressed-row affected-count cause lost")
				}
			} else {
				var driver *pgconn.PgError
				if !errors.As(err, &driver) || driver.Code != "P0001" {
					t.Fatal("original trigger SQLSTATE lost")
				}
			}
			if before != stepWitnessState(t, database, task.ID, false) {
				t.Fatal("partial target, interval, or parent write survived rollback")
			}
			if test.sequence != "" {
				var count int64
				if err := database.Pool.QueryRow(t.Context(), "SELECT last_value FROM "+pgx.Identifier{test.sequence}.Sanitize()).Scan(&count); err != nil || count != 2 {
					t.Fatalf("second actual row write was not reached: %d %v", count, err)
				}
			}
			assertMigrationPoolReusable(t, database.Pool)
			mustQueryExec(t, database, "DROP TRIGGER "+trigger+" ON "+table+"; DROP FUNCTION "+trigger+"()")
			assertFaultTriggerRemoved(t, database, test.trigger, test.table)
			if test.sequence != "" {
				mustQueryExec(t, database, "DROP SEQUENCE "+pgx.Identifier{test.sequence}.Sanitize())
				var retained *string
				if err := database.Pool.QueryRow(t.Context(), "SELECT to_regclass($1)::text", test.sequence).Scan(&retained); err != nil || retained != nil {
					t.Fatalf("attempt sequence was retained: %v %v", retained, err)
				}
			}
		}) {
			return
		}
	}
}

type stepCompetitionResult struct {
	index      int
	completion Completion
	err        error
}

func stepCompetitionMutation(ctx context.Context, dao TaskWriteDAO, taskID, operation string) error {
	rows, err := dao.TaskSteps(ctx, taskID)
	if err != nil {
		return err
	}
	if strings.HasPrefix(operation, "noop") {
		return nil
	}
	stamp, err := dao.ObservedAt(ctx)
	if err != nil {
		return err
	}
	switch operation {
	case "add_first", "add_second":
		id := "12345678"
		if operation == "add_second" {
			id = "87654321"
		}
		err = dao.InsertTaskStep(ctx, taskID, model.TaskStep{ID: id, Position: int64(len(rows)), Title: "Added", Status: model.TaskStepTodo, CreatedAt: stamp, UpdatedAt: stamp})
	case "change", "status":
		target := rows[0]
		if operation == "change" {
			target.Title = "changed"
		} else {
			target.Status = model.TaskStepDone
		}
		target.UpdatedAt = stamp
		err = dao.UpdateTaskStep(ctx, taskID, target)
	case "delete_first":
		err = dao.DeleteTaskStep(ctx, taskID, rows[0].ID, 0, int64(len(rows)-1))
	case "delete_last":
		err = dao.DeleteTaskStep(ctx, taskID, rows[len(rows)-1].ID, int64(len(rows)-1), 0)
	case "move_first":
		err = dao.MoveTaskStep(ctx, taskID, rows[0].ID, 0, int64(len(rows)-1))
	case "move_last":
		err = dao.MoveTaskStep(ctx, taskID, rows[len(rows)-1].ID, int64(len(rows)-1), 0)
	case "metadata":
		current, err := dao.Task(ctx, taskID)
		if err != nil {
			return err
		}
		_, err = dao.UpdateTask(ctx, taskID, TaskWrite{Title: "Parent changed", Description: current.Description, Status: current.Status, Properties: current.Properties, DependsOn: current.DependsOn, ExternalDependsOn: current.ExternalDependsOn, AssignedTo: current.AssignedTo, RequiredPlatform: current.RequiredPlatform, AllowAgents: current.AllowAgents})
		return err
	default:
		return fmt.Errorf("unknown competing step operation %q", operation)
	}
	if err != nil {
		return err
	}
	return dao.TouchTask(ctx, taskID, stamp)
}

func competeStepWitnessTransactions(t *testing.T, database *Store, projectID, taskID string, version int64, rejected error, operations [2]string) [2]stepCompetitionResult {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	blocker, err := database.Pool.Begin(ctx)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if _, err := blocker.Exec(ctx, "SELECT id FROM projects WHERE id=$1 FOR UPDATE", projectID); err != nil {
		cancel()
		_ = blocker.Rollback(context.Background())
		t.Fatal(err)
	}
	var group sync.WaitGroup
	defer func() {
		cancel()
		_ = blocker.Rollback(context.Background())
		group.Wait()
	}()
	results := make(chan stepCompetitionResult, 2)
	for index, operation := range operations {
		group.Add(1)
		go func() {
			defer group.Done()
			completion, err := database.WriteProject(ctx, projectID, func(scope ProjectWriteScope) error {
				header, err := scope.TaskDAO().TaskHeader(ctx, taskID)
				if err != nil {
					return err
				}
				if header.Version != version {
					return rejected
				}
				return stepCompetitionMutation(ctx, scope.TaskDAO(), taskID, operation)
			})
			results <- stepCompetitionResult{index: index, completion: completion, err: err}
		}()
	}
	application := database.Pool.Config().ConnConfig.RuntimeParams["application_name"]
	if application == "" {
		t.Fatal("competition fixture has no isolated application identity")
	}
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting int
		if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
 WHERE datname=current_database() AND application_name=$1 AND wait_event_type='Lock'
 AND query LIKE 'SELECT id::text FROM projects WHERE%'`, application).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == 2 {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("both actual project writers did not reach the held lock")
		case <-ticker.C:
		}
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var completed [2]stepCompetitionResult
	for range completed {
		select {
		case result := <-results:
			completed[result.index] = result
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	return completed
}

func TestTaskStepsCompetingWritesUseFreshSharedParentRevision(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	for index, test := range []struct {
		name       string
		operations [2]string
		rows       int
	}{
		{"add/add", [2]string{"add_first", "add_second"}, 0},
		{"add/metadata", [2]string{"add_first", "metadata"}, 0},
		{"change/status", [2]string{"change", "status"}, 2},
		{"change/add", [2]string{"change", "add_first"}, 2},
		{"change/metadata", [2]string{"change", "metadata"}, 2},
		{"delete/same_target", [2]string{"delete_first", "delete_first"}, 4},
		{"delete/different_target", [2]string{"delete_first", "delete_last"}, 4},
		{"delete/add", [2]string{"delete_first", "add_first"}, 4},
		{"delete/metadata", [2]string{"delete_first", "metadata"}, 4},
		{"move/move", [2]string{"move_first", "move_last"}, 4},
		{"move/add", [2]string{"move_first", "add_first"}, 4},
		{"move/metadata", [2]string{"move_first", "metadata"}, 4},
		{"change/noop", [2]string{"noop_change", "status"}, 2},
		{"move/noop", [2]string{"noop_move", "move_last"}, 4},
	} {
		t.Run(test.name, func(t *testing.T) {
			task := queryTask(t, database, project.ID, 50+index, model.TaskTodo)
			seedStepWitnessRows(t, database, task.ID, test.rows)
			_, before := readStepWitnessRows(t, database, project.ID, task.ID)
			rejected := errors.New("locked parent revision changed")
			results := competeStepWitnessTransactions(t, database, project.ID, task.ID, task.Version, rejected, test.operations)
			winner, successes := -1, 0
			for _, result := range results {
				if result.err == nil {
					if result.completion.Outcome != TransactionCommitted {
						t.Fatal("successful scope did not confirm commit")
					}
					successes++
					if !strings.HasPrefix(test.operations[result.index], "noop") {
						winner = result.index
					}
				} else if !errors.Is(result.err, rejected) || result.completion.Outcome != TransactionNotCommitted {
					t.Fatalf("fresh-revision refusal lost its rollback cause: %+v", result)
				}
			}
			if winner < 0 || successes < 1 || (successes != 1 && !strings.HasSuffix(test.name, "noop")) {
				t.Fatalf("unexpected physical competition outcome: %+v", results)
			}
			header, after := readStepWitnessRows(t, database, project.ID, task.ID)
			if header.Version != task.Version+1 {
				t.Fatal("competing writes did not advance exactly one shared revision")
			}
			operation := test.operations[winner]
			expected := append([]model.TaskStep{}, before...)
			switch operation {
			case "add_first", "add_second":
				id := "12345678"
				if operation == "add_second" {
					id = "87654321"
				}
				expected = append(expected, model.TaskStep{ID: id, Position: int64(len(before)), Title: "Added", Status: model.TaskStepTodo, CreatedAt: header.UpdatedAt, UpdatedAt: header.UpdatedAt})
			case "change":
				expected[0].Title, expected[0].UpdatedAt = "changed", header.UpdatedAt
			case "status":
				expected[0].Status, expected[0].UpdatedAt = model.TaskStepDone, header.UpdatedAt
			case "delete_first":
				expected = expected[1:]
			case "delete_last":
				expected = expected[:len(expected)-1]
			case "move_first":
				expected = append(expected[1:], expected[0])
			case "move_last":
				expected = append([]model.TaskStep{expected[len(expected)-1]}, expected[:len(expected)-1]...)
			}
			for position := range expected {
				expected[position].Position = int64(position)
			}
			if !reflect.DeepEqual(after, expected) {
				t.Fatalf("winner %s left incorrect or mixed physical effects: %#v expected %#v", operation, after, expected)
			}
			parent := snapshotTask(t, database, project.ID, task.ID)
			if (parent.Title == "Parent changed") != (operation == "metadata") {
				t.Fatal("Step and metadata effects both committed or neither survived")
			}
		})
	}
	assertMigrationPoolReusable(t, database.Pool)
}
