package task_test

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/google/uuid"
)

func TestCancellationCompetesWithClaimResumeAndWithdrawal(t *testing.T) {
	for _, operation := range []string{"claim", "resume", "withdraw"} {
		t.Run(operation, func(t *testing.T) {
			tasks, database, project, _, owner := taskService(t)
			target := claimableTask(t, tasks, owner, project.ID)
			descriptor := workerDescriptor()
			if operation != "claim" {
				target = claimWorkerTask(t, tasks, owner, target, descriptor)
				var err error
				target, err = tasks.ReleaseWorker(t.Context(), owner, project.ID, target.ID, taskcore.ReleaseWorker{Version: target.Version, ClaimID: descriptor.ClaimID, StoppedConfirmed: true})
				if err != nil {
					t.Fatal(err)
				}
			}
			fresh := workerDescriptor()
			results := competeTaskWrites(t, database, project.ID,
				func(ctx context.Context) (model.Task, error) {
					return tasks.SetStatus(ctx, owner, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskCancelled})
				},
				func(ctx context.Context) (model.Task, error) {
					switch operation {
					case "claim":
						return tasks.ClaimWorker(ctx, owner, project.ID, target.ID, taskcore.ClaimWorker{Version: target.Version, WorkerDescriptor: fresh})
					case "resume":
						return tasks.ResumeWorker(ctx, owner, project.ID, target.ID, taskcore.ResumeWorker{ClaimWorker: taskcore.ClaimWorker{Version: target.Version, WorkerDescriptor: fresh}, PreviousClaimID: descriptor.ClaimID})
					default:
						return tasks.WithdrawWorker(ctx, owner, project.ID, target.ID, taskcore.WithdrawWorker{Version: target.Version, ClaimID: descriptor.ClaimID})
					}
				})
			assertOneTaskWinner(t, results, "version_conflict")
			after, err := tasks.Get(t.Context(), owner, project.ID, target.ID)
			if err != nil || after.Version != target.Version+1 {
				t.Fatal(after, err)
			}
			if after.Status == model.TaskCancelled {
				if after.CancelledAt == nil || !reflect.DeepEqual(after.Properties, target.Properties) || after.AllowAgents != target.AllowAgents {
					t.Fatalf("cancellation lost history or permission: %+v", after)
				}
			} else if after.CancelledAt != nil || operation == "withdraw" && after.Status != model.TaskTodo || operation != "withdraw" && after.Status != model.TaskInProgress {
				t.Fatalf("competing operation left inconsistent state: %+v", after)
			}
		})
	}
}

func TestCancellationAndSessionFreezeRollbackTogetherWithoutEpochReplacement(t *testing.T) {
	for _, failure := range []string{"session", "receipt", "none"} {
		t.Run(failure, func(t *testing.T) {
			tasks, database, project, _, principal := taskService(t)
			target := createTask(t, tasks, principal, project.ID, "Cancellation")
			sessionID, operationID := uuid.NewString(), uuid.NewString()
			snapshot, err := json.Marshal(map[string]any{"lifecycle": "active", "lastTimelineSeq": "4", "controls": []string{"control"}})
			if err != nil {
				t.Fatal(err)
			}
			receipt := []byte(`{"state":"accepted","error":null}`)
			if _, err := database.Pool.Exec(t.Context(), `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot)
				VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, sessionID, project.ID, target.ID, uuid.NewString(), principal.UserID, uuid.NewString(), snapshot); err != nil {
				t.Fatal(err)
			}
			if _, err := database.Pool.Exec(t.Context(), `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt)
				VALUES($1,$2,1,'\x01','{}',$3,$4,'pat',$5)`, sessionID, operationID, principal.UserID, principal.CredentialID, receipt); err != nil {
				t.Fatal(err)
			}
			var beforeEpoch string
			if err := database.Pool.QueryRow(t.Context(), `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&beforeEpoch); err != nil {
				t.Fatal(err)
			}
			if failure != "none" {
				table := "task_sessions"
				if failure == "receipt" {
					table = "session_operations"
				}
				if _, err := database.Pool.Exec(t.Context(), `CREATE FUNCTION reject_cancellation_freeze() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'cancellation freeze failure'; END $$;
					CREATE TRIGGER reject_cancellation_freeze BEFORE UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION reject_cancellation_freeze()`); err != nil {
					t.Fatal(err)
				}
			}
			_, err = tasks.SetStatus(t.Context(), principal, project.ID, target.ID, taskcore.SetTaskStatus{Version: target.Version, Status: model.TaskCancelled})
			if (failure == "none") != (err == nil) {
				t.Fatalf("cancel result: %v", err)
			}
			after, err := tasks.Get(t.Context(), principal, project.ID, target.ID)
			if err != nil {
				t.Fatal(err)
			}
			var epoch, lifecycle, state string
			if err := database.Pool.QueryRow(t.Context(), `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
				t.Fatal(err)
			}
			if err := database.Pool.QueryRow(t.Context(), `SELECT snapshot->>'lifecycle' FROM task_sessions WHERE id=$1`, sessionID).Scan(&lifecycle); err != nil {
				t.Fatal(err)
			}
			if err := database.Pool.QueryRow(t.Context(), `SELECT receipt->>'state' FROM session_operations WHERE operation_id=$1`, operationID).Scan(&state); err != nil {
				t.Fatal(err)
			}
			if epoch != beforeEpoch {
				t.Fatal("business cancellation replaced the live task-cache history")
			}
			if failure == "none" {
				if after.Status != model.TaskCancelled || after.CancelledAt == nil || !after.CancelledAt.Equal(after.UpdatedAt) || after.Version != target.Version+1 || lifecycle != "draining" || state != "rejected" {
					t.Fatalf("incomplete cancellation/freeze: %+v %s %s", after, lifecycle, state)
				}
			} else if !reflect.DeepEqual(after, target) || lifecycle != "active" || state != "accepted" {
				t.Fatalf("failed freeze partially committed cancellation: %+v %s %s", after, lifecycle, state)
			}
		})
	}
}
