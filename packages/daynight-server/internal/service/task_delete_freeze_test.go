package service

import (
	"context"
	"encoding/json"
	"testing"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/google/uuid"
)

func TestTaskDeletionSessionFreezeAndCacheEpochAreAtomic(t *testing.T) {
	for _, failure := range []string{"session", "epoch", "none"} {
		t.Run(failure, func(t *testing.T) {
			tasks, db, project, _, principal := taskService(t)
			ctx := context.Background()
			task := createTask(t, tasks, principal, project.ID, "Deletion")
			sessionID, claimID, operationID := uuid.NewString(), uuid.NewString(), uuid.NewString()
			snapshot, _ := json.Marshal(map[string]any{"lifecycle": "active", "lastTimelineSeq": "4", "controls": []string{"control"}})
			receipt, _ := json.Marshal(map[string]any{"state": "accepted", "error": nil})
			if _, err := db.Pool.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, sessionID, project.ID, task.ID, claimID, principal.UserID, uuid.NewString(), snapshot); err != nil {
				t.Fatal(err)
			}
			if _, err := db.Pool.Exec(ctx, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,1,'\x01','{}',$3,$4,'pat',$5)`, sessionID, operationID, principal.UserID, principal.CredentialID, receipt); err != nil {
				t.Fatal(err)
			}
			var beforeEpoch string
			if err := db.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&beforeEpoch); err != nil {
				t.Fatal(err)
			}
			switch failure {
			case "session":
				_, err := db.Pool.Exec(ctx, `CREATE FUNCTION reject_freeze() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'freeze failure'; END $$; CREATE TRIGGER reject_freeze BEFORE UPDATE ON task_sessions FOR EACH ROW EXECUTE FUNCTION reject_freeze()`)
				if err != nil {
					t.Fatal(err)
				}
			case "epoch":
				_, err := db.Pool.Exec(ctx, `CREATE FUNCTION reject_epoch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'epoch failure'; END $$; CREATE TRIGGER reject_epoch BEFORE UPDATE OF task_cache_epoch ON projects FOR EACH ROW EXECUTE FUNCTION reject_epoch()`)
				if err != nil {
					t.Fatal(err)
				}
			}
			err := tasks.Delete(ctx, principal, project.ID, task.ID, taskcore.DeleteTask{Version: task.Version})
			if (failure == "none") != (err == nil) {
				t.Fatalf("delete error: %v", err)
			}
			var deleted bool
			var version int64
			var epoch, lifecycle, state string
			if err := db.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL,version FROM tasks WHERE id=$1`, task.ID).Scan(&deleted, &version); err != nil {
				t.Fatal(err)
			}
			if err := db.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
				t.Fatal(err)
			}
			if err := db.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle' FROM task_sessions WHERE id=$1`, sessionID).Scan(&lifecycle); err != nil {
				t.Fatal(err)
			}
			if err := db.Pool.QueryRow(ctx, `SELECT receipt->>'state' FROM session_operations WHERE operation_id=$1`, operationID).Scan(&state); err != nil {
				t.Fatal(err)
			}
			if failure == "none" {
				if !deleted || version != task.Version+1 || epoch == beforeEpoch || lifecycle != "draining" || state != "rejected" {
					t.Fatalf("incomplete deletion: %v %d %s %s %s", deleted, version, epoch, lifecycle, state)
				}
			} else if deleted || version != task.Version || epoch != beforeEpoch || lifecycle != "active" || state != "accepted" {
				t.Fatalf("failed deletion committed partial effects: %v %d %s %s %s", deleted, version, epoch, lifecycle, state)
			}
		})
	}
}
