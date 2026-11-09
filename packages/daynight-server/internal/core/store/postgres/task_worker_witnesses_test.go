package postgres

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5/pgconn"
)

func workerWitnessPointer[T any](value T) *T { return testutil.Pointer(value) }

func workerWitnessClaim(number int, userID, workerID string, state model.WorkerState) *model.WorkerClaim {
	return testutil.WorkerClaim(number, userID, workerID, state)
}

func TestWorkerWithdrawalRollsBackPartialDatabaseFailure(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	dependency := queryTask(t, database, project.ID, 2, model.TaskDone)
	target := queryTask(t, database, project.ID, 3, model.TaskTodo, dependency.ID)
	claim := workerWitnessClaim(3, queryID(4), queryID(5), model.WorkerReleased)
	values := taskPropertyWriteValues(target)
	values.Status, values.AllowAgents, values.Properties = model.TaskInProgress, true, fixtureTaskProperties(t, claim)
	if err := writeProjectForTest(database, context.Background(), project.ID, func(scope ProjectWriteScope) error {
		var err error
		target, err = scope.TaskDAO().UpdateTask(context.Background(), target.ID, values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if target.StartedAt == nil {
		t.Fatal("withdrawal fixture has no execution history")
	}
	before := taskPropertyFacts(t, database)
	mustQueryExec(t, database, `CREATE FUNCTION reject_worker_withdrawal_edge() RETURNS trigger LANGUAGE plpgsql AS $$
		BEGIN RAISE EXCEPTION USING ERRCODE='P1204',MESSAGE='private withdrawal edge failure'; END $$;
		CREATE TRIGGER reject_worker_withdrawal_edge BEFORE DELETE ON task_dependencies FOR EACH ROW EXECUTE FUNCTION reject_worker_withdrawal_edge()`)
	values = taskPropertyWriteValues(target)
	values.Status, values.AllowAgents, values.Properties = model.TaskTodo, false, model.TaskProperties{}
	completion, err := database.WriteProject(context.Background(), project.ID, func(scope ProjectWriteScope) error {
		_, err := scope.TaskDAO().UpdateTask(context.Background(), target.ID, values)
		return err
	})
	var cause *pgconn.PgError
	if completion.Outcome != TransactionNotCommitted || !errors.As(err, &cause) || cause.Code != "P1204" || !reflect.DeepEqual(taskPropertyFacts(t, database), before) {
		t.Fatalf("partial withdrawal lost execution history, worker, edges, cause or rollback: %+v %v", completion, err)
	}
}
