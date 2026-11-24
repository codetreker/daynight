package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

type claimTaskLockWitnessStore struct {
	*Store
	check func(context.Context) error
}
type claimTaskLockWitnessScope struct {
	ProjectWriteScope
	check func(context.Context) error
}
type claimTaskLockWitnessAdmission struct {
	WorkerClaimAdmissionDAO
	check func(context.Context) error
}

func (s claimTaskLockWitnessStore) WriteProject(ctx context.Context, project string, apply func(ProjectWriteScope) error) (Completion, error) {
	return s.Store.WriteProject(ctx, project, func(scope ProjectWriteScope) error { return apply(claimTaskLockWitnessScope{scope, s.check}) })
}
func (s claimTaskLockWitnessScope) WorkerClaimAdmissionDAO() WorkerClaimAdmissionDAO {
	return claimTaskLockWitnessAdmission{s.ProjectWriteScope.WorkerClaimAdmissionDAO(), s.check}
}
func (d claimTaskLockWitnessAdmission) ClaimWorkerConfiguration(ctx context.Context, user, worker string) (*model.WorkerDesiredConfiguration, error) {
	if err := d.check(ctx); err != nil {
		return nil, err
	}
	return d.WorkerClaimAdmissionDAO.ClaimWorkerConfiguration(ctx, user, worker)
}

func TestWorkerClaimStartsDirectGoalAtomicallyBeforeWorkerLock(t *testing.T) {
	for _, failGoal := range []bool{false, true} {
		t.Run(map[bool]string{false: "commit", true: "rollback"}[failGoal], func(t *testing.T) {
			db, principal, _, project := membershipFixture(t)
			ctx := t.Context()
			goal, child, workerID := uuid.NewString(), uuid.NewString(), uuid.NewString()
			mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','Owner','todo')`, goal, project.ID)
			mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,parent_id,type,title,status,assigned_to,allow_agents) VALUES($1,$2,$3,'task','Child','todo',$4,true)`, child, project.ID, goal, principal.UserID)
			testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(principal.UserID, workerID, time.Now().UTC()))
			beforeGoal, beforeChild := snapshotTask(t, db, project.ID, goal), snapshotTask(t, db, project.ID, child)
			if failGoal {
				mustQueryExec(t, db, `CREATE FUNCTION refuse_goal_start() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='goal' AND NEW.status='in_progress' THEN RAISE EXCEPTION 'injected Goal failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER refuse_goal_start BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION refuse_goal_start()`)
			}
			checks := 0
			witness := claimTaskLockWitnessStore{Store: db, check: func(ctx context.Context) error {
				checks++
				for _, id := range []string{goal, child} {
					probe, err := db.Pool.Begin(ctx)
					if err != nil {
						return err
					}
					_, lockErr := probe.Exec(ctx, `SELECT id FROM tasks WHERE id=$1 FOR SHARE NOWAIT`, id)
					if err := probe.Rollback(ctx); err != nil {
						return err
					}
					var fault *pgconn.PgError
					if !errors.As(lockErr, &fault) || fault.Code != "55P03" {
						return fmt.Errorf("Task %s was not locked before Worker configuration: %w", id, lockErr)
					}
				}
				return nil
			}}
			descriptor := taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: workerID, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString()}
			claimed, err := taskservice.NewTasks(witness).ClaimWorker(ctx, principal, project.ID, child, taskcore.ClaimWorker{Version: beforeChild.Version, WorkerDescriptor: descriptor})
			if checks != 1 {
				t.Fatalf("Worker admission checks=%d", checks)
			}
			afterGoal, afterChild := snapshotTask(t, db, project.ID, goal), snapshotTask(t, db, project.ID, child)
			if failGoal {
				var failure *pgconn.PgError
				if !errors.As(err, &failure) || failure.Code != "P0001" {
					t.Fatalf("lost Goal failure: %v", err)
				}
				if !reflect.DeepEqual(beforeGoal, afterGoal) || !reflect.DeepEqual(beforeChild, afterChild) {
					t.Fatalf("failed Goal start persisted claim or Goal: child=%+v Goal=%+v", afterChild, afterGoal)
				}
			} else if err != nil || afterGoal.Status != model.TaskInProgress || afterGoal.Version != beforeGoal.Version+1 || afterChild.Status != model.TaskInProgress || !reflect.DeepEqual(afterChild, claimed) {
				t.Fatalf("claim and Goal not committed together: child=%+v Goal=%+v err=%v", afterChild, afterGoal, err)
			}
		})
	}
}

func TestWorkerClaimTraversesOrdinaryParentsAndRetainsExistingClaim(t *testing.T) {
	db, principal, _, project := membershipFixture(t)
	ctx := t.Context()
	goal, parent := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,type,title,status) VALUES($1,$2,'goal','Owner','todo')`, goal, project.ID)
	ancestors := []string{goal}
	for depth := 0; depth < 5; depth++ {
		id := uuid.NewString()
		if depth == 0 {
			id = parent
		}
		mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,parent_id,type,title,status) VALUES($1,$2,$3,'task','Parent','todo')`, id, project.ID, ancestors[len(ancestors)-1])
		ancestors = append(ancestors, id)
	}
	leaf, sibling := uuid.NewString(), uuid.NewString()
	for _, id := range []string{leaf, sibling} {
		mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,parent_id,type,title,status,assigned_to,allow_agents) VALUES($1,$2,$3,'task','Leaf','todo',$4,true)`, id, project.ID, ancestors[len(ancestors)-1], principal.UserID)
	}
	before := make([]model.Task, len(ancestors))
	for i, id := range ancestors {
		before[i] = snapshotTask(t, db, project.ID, id)
	}
	workerID := uuid.NewString()
	testutil.PutWorkerSnapshot(t, db, testutil.WorkerSnapshotFixture(principal.UserID, workerID, time.Now().UTC()))
	tasks := taskservice.NewTasks(db)
	allowed, ready := true, true
	request := taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 1}, AutomaticCandidate: true, CandidateWorkerID: &workerID, Ready: &ready, AllowAgents: &allowed, AssignedTo: &principal.UserID}
	first, err := tasks.List(ctx, principal, project.ID, request)
	if err != nil || len(first.Items) != 1 || first.NextCursor == nil {
		t.Fatalf("open candidates: %+v %v", first, err)
	}
	request.Cursor = first.NextCursor
	second, err := tasks.List(ctx, principal, project.ID, request)
	if err != nil || len(second.Items) != 1 || second.Items[0].ID == first.Items[0].ID || second.NextCursor != nil {
		t.Fatalf("candidate continuation: %+v %v", second, err)
	}
	current := snapshotTask(t, db, project.ID, leaf)
	descriptor := taskcore.WorkerDescriptor{ClaimID: uuid.NewString(), WorkerID: workerID, Machine: model.WorkerMachine{ID: uuid.NewString(), Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb, WorktreeID: uuid.NewString()}
	claimed, err := tasks.ClaimWorker(ctx, principal, project.ID, leaf, taskcore.ClaimWorker{Version: current.Version, WorkerDescriptor: descriptor})
	if err != nil {
		t.Fatal(err)
	}
	after := snapshotTask(t, db, project.ID, leaf)
	claim, err := taskproperty.Worker(after.Properties)
	if err != nil || claim == nil || claim.ClaimID != descriptor.ClaimID || !reflect.DeepEqual(after, claimed) || after.Status != model.TaskInProgress {
		t.Fatalf("deep claim not committed: %+v %v", after, err)
	}
	for i, id := range ancestors {
		if got := snapshotTask(t, db, project.ID, id); !reflect.DeepEqual(got, before[i]) {
			t.Fatalf("ancestor changed: before=%+v after=%+v", before[i], got)
		}
	}
	for _, status := range []model.TaskStatus{model.TaskDone, model.TaskCancelled} {
		mustQueryExec(t, db, `UPDATE tasks SET status=$2,cancelled_at=CASE WHEN $2='cancelled' THEN now() END WHERE id=$1`, goal, status)
		request.Cursor = nil
		page, err := tasks.List(ctx, principal, project.ID, request)
		if err != nil || len(page.Items) != 0 {
			t.Fatalf("terminal Goal candidates: %+v %v", page, err)
		}
		siblingTask := snapshotTask(t, db, project.ID, sibling)
		descriptor.ClaimID, descriptor.WorktreeID = uuid.NewString(), uuid.NewString()
		_, err = tasks.ClaimWorker(ctx, principal, project.ID, sibling, taskcore.ClaimWorker{Version: siblingTask.Version, WorkerDescriptor: descriptor})
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "invalid_transition" {
			t.Fatalf("terminal ancestor claim: %v", err)
		}
		if got := snapshotTask(t, db, project.ID, sibling); !reflect.DeepEqual(got, siblingTask) {
			t.Fatalf("rejected sibling changed: %+v", got)
		}
		inventory, err := tasks.List(ctx, principal, project.ID, taskservice.TaskListRequest{PageRequest: model.PageRequest{Limit: 10}, WorkerID: &workerID})
		if err != nil || len(inventory.Items) != 1 || inventory.Items[0].ID != leaf {
			t.Fatalf("retained claim omitted: %+v %v", inventory, err)
		}
		if got := snapshotTask(t, db, project.ID, leaf); !reflect.DeepEqual(got, after) {
			t.Fatalf("ancestor terminal changed existing claim: %+v", got)
		}
	}
	phase := model.WorkerExecuting
	updated, err := tasks.UpdateWorker(ctx, principal, project.ID, leaf, taskcore.UpdateWorker{Version: after.Version, ClaimID: claim.ClaimID, Phase: &phase})
	if err != nil {
		t.Fatalf("terminal ancestor prevented existing claim report: %v", err)
	}
	if got := snapshotTask(t, db, project.ID, leaf); !reflect.DeepEqual(got, updated) {
		t.Fatalf("existing claim report was not persisted: %+v", got)
	}
}

func workerWitnessPointer[T any](value T) *T { return testutil.Pointer(value) }

func workerWitnessClaim(number int, userID, workerID string, state model.WorkerState) *model.WorkerClaim {
	return testutil.WorkerClaim(number, userID, workerID, state)
}

func TestWorkerWithdrawalRollsBackPartialDatabaseFailure(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	project := queryProject(t, database, 1)
	dependency := queryTask(t, database, project.ID, 2, model.TaskDone)
	target := queryTask(t, database, project.ID, 3, model.TaskTodo, dependency.ID)
	claim := workerWitnessClaim(3, queryID(4), queryID(5), model.WorkerActive)
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
