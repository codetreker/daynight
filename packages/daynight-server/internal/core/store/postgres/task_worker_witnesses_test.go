package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5/pgconn"
)

func workerWitnessPointer[T any](value T) *T { return &value }

func workerWitnessClaim(number int, userID, workerID string, state model.WorkerState) *model.WorkerClaim {
	return &model.WorkerClaim{ClaimID: queryID(number + 100), State: state, UserID: userID, WorkerID: workerID,
		Machine: model.WorkerMachine{ID: queryID(4), Name: "Build"}, Platform: model.PlatformLinux,
		Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: queryID(number + 200), Phase: model.WorkerPreparing, ClaimedAt: time.Now().UTC()}
}

func workerWitnessTask(t *testing.T, database *Store, projectID string, number int, claim *model.WorkerClaim, allow bool, platform *model.TaskPlatform) model.Task {
	t.Helper()
	status := model.TaskInProgress
	if claim != nil && claim.State == model.WorkerCompleted {
		status = model.TaskDone
	}
	task := queryTask(t, database, projectID, number, status)
	if claim != nil {
		properties := fixtureTaskProperties(t, claim)
		putTaskPropertyFixture(t, database, task.ID, "worker", properties["worker"])
	}
	mustQueryExec(t, database, `UPDATE tasks SET allow_agents=$2,required_platform=$3 WHERE id=$1`, task.ID, allow, platform)
	return snapshotTask(t, database, projectID, task.ID)
}

func workerWitnessPage(t *testing.T, database *Store, projectID string, query TaskQuery) TaskPage {
	t.Helper()
	var page TaskPage
	if err := database.ReadSnapshot(context.Background(), func(scope SnapshotScope) error {
		var err error
		page, err = scope.TaskDAO().Tasks(context.Background(), projectID, query)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return page
}

func TestTaskWorkerInventoryFiltersBeforeLimitAndBindsWorkerAndUser(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	owner, other, workerID := queryID(2), queryID(3), queryID(5)
	queryTask(t, database, project.ID, 10, model.TaskTodo)
	workerWitnessTask(t, database, project.ID, 11, workerWitnessClaim(11, owner, queryID(6), model.WorkerActive), true, nil)
	workerWitnessTask(t, database, project.ID, 12, workerWitnessClaim(12, other, workerID, model.WorkerActive), true, nil)
	workerWitnessTask(t, database, project.ID, 13, workerWitnessClaim(13, owner, workerID, model.WorkerReleased), true, nil)
	workerWitnessTask(t, database, project.ID, 14, workerWitnessClaim(14, owner, workerID, model.WorkerCompleted), true, nil)
	first := workerWitnessTask(t, database, project.ID, 15, workerWitnessClaim(15, owner, workerID, model.WorkerActive), true, nil)
	workerWitnessTask(t, database, project.ID, 16, workerWitnessClaim(16, other, workerID, model.WorkerActive), true, nil)
	second := workerWitnessTask(t, database, project.ID, 17, workerWitnessClaim(17, owner, workerID, model.WorkerActive), true, nil)
	manual := workerWitnessTask(t, database, project.ID, 18, workerWitnessClaim(18, owner, workerID, model.WorkerActive), false, workerWitnessPointer(model.PlatformWindows))
	mustQueryExec(t, database, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id,external) VALUES($1,$2,$3,true)`, project.ID, first.ID, queryID(14))
	want := []string{first.ID, second.ID, manual.ID}
	query := TaskQuery{Page: Page{Limit: 1}, Worker: &WorkerQuery{UserID: owner, WorkerID: workerID}}
	var ids []string
	for {
		page := workerWitnessPage(t, database, project.ID, query)
		if len(page.Items) != 1 {
			t.Fatalf("owned page lost a valid candidate: %+v", page)
		}
		ids = append(ids, page.Items[0].ID)
		if page.Items[0].ID == first.ID && (!slices.Equal(page.Items[0].DependsOn, []string{queryID(14)}) || !slices.Equal(page.Items[0].ExternalDependsOn, []string{queryID(14)}) || len(page.Items[0].BlockedBy) != 0 || !reflect.DeepEqual(fixtureWorker(t, page.Items[0].Properties), fixtureWorker(t, first.Properties))) {
			t.Fatalf("owned inventory lost the current claim or external dependency flags: %#v", page.Items[0])
		}
		if !page.HasMore {
			break
		}
		query.Page.After = &Position{CreatedAt: page.Items[0].CreatedAt, ID: page.Items[0].ID}
	}
	if !slices.Equal(ids, want) {
		t.Fatalf("ownership filter did not precede the page limit: %v want %v", ids, want)
	}
	for _, test := range []struct {
		query TaskQuery
		want  []string
	}{
		{TaskQuery{Ready: workerWitnessPointer(false)}, want},
		{TaskQuery{Ready: workerWitnessPointer(true)}, nil},
		{TaskQuery{AllowAgents: workerWitnessPointer(true)}, want[:2]},
		{TaskQuery{AllowAgents: workerWitnessPointer(false)}, want[2:]},
		{TaskQuery{CompatiblePlatform: workerWitnessPointer(model.PlatformLinux)}, want[:2]},
		{TaskQuery{Status: workerWitnessPointer(model.TaskInProgress)}, want},
		{TaskQuery{Status: workerWitnessPointer(model.TaskTodo)}, nil},
	} {
		test.query.Page, test.query.Worker = Page{Limit: 100}, &WorkerQuery{UserID: owner, WorkerID: workerID}
		page := workerWitnessPage(t, database, project.ID, test.query)
		var actual []string
		for _, task := range page.Items {
			actual = append(actual, task.ID)
		}
		if !slices.Equal(actual, test.want) || page.HasMore {
			t.Fatalf("combined filter changed inventory: %v want %v", actual, test.want)
		}
	}
}

func TestTaskWorkerInventoryTracksCurrentClaimAcrossOwnershipChanges(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	owner, workerID := queryID(2), queryID(3)
	claim := workerWitnessClaim(10, owner, workerID, model.WorkerActive)
	target := workerWitnessTask(t, database, project.ID, 10, claim, true, nil)
	query := TaskQuery{Page: Page{Limit: 1}, Worker: &WorkerQuery{UserID: owner, WorkerID: workerID}}
	check := func(expected *model.WorkerClaim) {
		t.Helper()
		page := workerWitnessPage(t, database, project.ID, query)
		if expected == nil {
			if len(page.Items) != 0 || page.HasMore {
				t.Fatalf("historical claim remained in inventory: %+v", page)
			}
			return
		}
		if len(page.Items) != 1 || page.Items[0].ID != target.ID || !reflect.DeepEqual(fixtureWorker(t, page.Items[0].Properties), expected) || page.HasMore {
			t.Fatalf("inventory selected a stale claim: %+v", page)
		}
	}
	check(claim)
	for _, state := range []model.WorkerState{model.WorkerReleased, model.WorkerActive, model.WorkerCompleted, model.WorkerActive} {
		claim = workerWitnessClaim(20+int(target.Version), owner, workerID, state)
		values := taskPropertyWriteValues(target)
		values.Properties = fixtureTaskProperties(t, claim)
		if state == model.WorkerCompleted {
			values.Status = model.TaskDone
		} else {
			values.Status = model.TaskInProgress
		}
		if err := writeProjectForTest(database, context.Background(), project.ID, func(scope ProjectWriteScope) error {
			var err error
			target, err = scope.TaskDAO().UpdateTask(context.Background(), target.ID, values)
			return err
		}); err != nil {
			t.Fatal(err)
		}
		if state == model.WorkerActive {
			check(claim)
		} else {
			check(nil)
		}
	}
	values := taskPropertyWriteValues(target)
	values.Properties, values.AllowAgents = model.TaskProperties{}, false
	if err := writeProjectForTest(database, context.Background(), project.ID, func(scope ProjectWriteScope) error {
		_, err := scope.TaskDAO().UpdateTask(context.Background(), target.ID, values)
		return err
	}); err != nil {
		t.Fatal(err)
	}
	check(nil)
}

func TestTaskWorkerInventoryPreservesJSONDecodeFailure(t *testing.T) {
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	target := queryTask(t, database, project.ID, 2, model.TaskTodo)
	putTaskPropertyFixture(t, database, target.ID, "worker", []byte(`{"workerId":123}`))
	var page TaskPage
	err := database.ReadSnapshot(context.Background(), func(scope SnapshotScope) error {
		var err error
		page, err = scope.TaskDAO().Tasks(context.Background(), project.ID, TaskQuery{Page: Page{Limit: 1}, Worker: &WorkerQuery{UserID: queryID(3), WorkerID: queryID(4)}})
		return err
	})
	var failure *Error
	var invalid *json.UnmarshalTypeError
	if !errors.As(err, &failure) || !errors.As(err, &invalid) || errors.Unwrap(err) == nil || len(page.Items) != 0 {
		t.Fatalf("invalid persisted ownership became an empty success or lost its cause: %+v %v", page, err)
	}
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
