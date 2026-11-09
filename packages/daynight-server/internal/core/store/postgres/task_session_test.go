package postgres

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestTaskSessionMigrationCreatesDurableRelayTables(t *testing.T) {
	s := isolatedStore(t)
	for _, table := range []string{"task_sessions", "session_events", "session_timeline", "session_operations", "session_resources"} {
		var count int
		if err := s.Pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&count); err != nil {
			t.Fatalf("missing durable relay table %s: %v", table, err)
		}
	}
}

func taskSessionTransitionFacts(t *testing.T, database *Store) map[string]string {
	t.Helper()
	facts := taskPropertyFacts(t, database)
	for _, table := range []string{"task_sessions", "session_operations"} {
		var raw string
		if err := database.Pool.QueryRow(context.Background(), `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb)::text FROM `+table+` t`).Scan(&raw); err != nil {
			t.Fatal(err)
		}
		facts[table] = raw
	}
	return facts
}

func TestTaskDeletionSessionFreezeAndCacheEpochAreAtomic(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	project := queryProject(t, database, 1)
	task := queryTask(t, database, project.ID, 2, model.TaskTodo)
	session, claim, operation := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snapshot, err := json.Marshal(map[string]any{"lifecycle": "active", "lastTimelineSeq": "4", "controls": []string{"control"}})
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := json.Marshal(map[string]any{"state": "accepted", "error": nil})
	if err != nil {
		t.Fatal(err)
	}
	mustQueryExec(t, database, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, session, project.ID, task.ID, claim, uuid.NewString(), uuid.NewString(), snapshot)
	mustQueryExec(t, database, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,1,'\x01','{}',$3,$4,'pat',$5)`, session, operation, uuid.NewString(), uuid.NewString(), receipt)
	before := taskSessionTransitionFacts(t, database)
	var beforeEpoch string
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&beforeEpoch); err != nil {
		t.Fatal(err)
	}
	remove := func() (Completion, error) {
		return database.WriteProject(ctx, project.ID, func(scope ProjectWriteScope) error {
			if _, err := scope.TaskDAO().DeleteTask(ctx, task.ID, false); err != nil {
				return err
			}
			if err := scope.SessionDAO().DrainTaskSessions(ctx, task.ID, TaskSessionDrain{
				SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle",
				RemoveFields:   []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
				SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"},
			}); err != nil {
				return err
			}
			if err := scope.SessionDAO().TransitionTaskSessionReceipts(ctx, task.ID, TaskSessionReceiptTransition{
				LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"},
			}); err != nil {
				return err
			}
			return scope.ProjectDAO().InvalidateTaskCache(ctx)
		})
	}
	for _, failure := range []struct{ table, columns string }{{"task_sessions", ""}, {"projects", " OF task_cache_epoch"}} {
		t.Run(failure.table, func(t *testing.T) {
			mustQueryExec(t, database, `CREATE FUNCTION refuse_task_deletion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deletion failure'; END $$`)
			mustQueryExec(t, database, `CREATE TRIGGER refuse_task_deletion BEFORE UPDATE`+failure.columns+` ON `+failure.table+` FOR EACH ROW EXECUTE FUNCTION refuse_task_deletion()`)
			completion, err := remove()
			if err == nil || completion.Outcome != TransactionNotCommitted || !reflect.DeepEqual(taskSessionTransitionFacts(t, database), before) {
				t.Fatalf("failed deletion committed partial Task/Session/receipt state: %+v %v", completion, err)
			}
			var epoch string
			if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil || epoch != beforeEpoch {
				t.Fatalf("failed deletion rotated cache epoch: %s %v", epoch, err)
			}
			mustQueryExec(t, database, `DROP TRIGGER refuse_task_deletion ON `+failure.table)
			mustQueryExec(t, database, `DROP FUNCTION refuse_task_deletion()`)
		})
	}
	completion, err := remove()
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("delete completion: %+v %v", completion, err)
	}
	var deleted bool
	var version int64
	var epoch, lifecycle, state string
	if err := database.Pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL,version FROM tasks WHERE id=$1`, task.ID).Scan(&deleted, &version); err != nil {
		t.Fatal(err)
	}
	if err := database.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil {
		t.Fatal(err)
	}
	if err := database.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle' FROM task_sessions WHERE id=$1`, session).Scan(&lifecycle); err != nil {
		t.Fatal(err)
	}
	if err := database.Pool.QueryRow(ctx, `SELECT receipt->>'state' FROM session_operations WHERE operation_id=$1`, operation).Scan(&state); err != nil {
		t.Fatal(err)
	}
	if !deleted || version != task.Version+1 || epoch == beforeEpoch || lifecycle != "draining" || state != "rejected" {
		t.Fatalf("incomplete committed deletion: %t %d %s %s %s", deleted, version, epoch, lifecycle, state)
	}
}

func TestTaskSessionFreezeAndReceiptFailureRollBackTaskTransitions(t *testing.T) {
	for _, status := range []model.TaskStatus{model.TaskDone, model.TaskCancelled} {
		t.Run(string(status), func(t *testing.T) {
			ctx := context.Background()
			s := isolatedStore(t)
			project := queryProject(t, s, 1)
			initial := model.TaskInProgress
			if status == model.TaskCancelled {
				initial = model.TaskTodo
			}
			task := queryTask(t, s, project.ID, 2, initial)
			session, claim, operation := uuid.NewString(), uuid.NewString(), uuid.NewString()
			snapshot := map[string]any{"sessionId": session, "claimId": claim, "executionGeneration": "1", "connectionEpoch": "1", "sessionRevision": "1", "lastEventSeq": "0", "historyEpoch": uuid.NewString(), "lifecycle": "active", "lastTimelineSeq": "7", "controls": []any{"control"}, "cleanupInteractionIds": []any{"cleanup"}, "turnStartedAt": "2026-01-01T00:00:00Z", "currentTurnId": "turn"}
			raw, err := json.Marshal(snapshot)
			if err != nil {
				t.Fatal(err)
			}
			receipt, err := json.Marshal(map[string]any{"sessionId": session, "claimId": claim, "executionGeneration": "1", "operationId": operation, "kind": "send_message", "protocol": "daynight.session.v1", "state": "accepted", "providerResult": nil, "error": nil})
			if err != nil {
				t.Fatal(err)
			}
			mustQueryExec(t, s, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, session, project.ID, task.ID, claim, uuid.NewString(), uuid.NewString(), raw)
			mustQueryExec(t, s, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,1,'\x01','{}',$3,$4,'pat',$5)`, session, operation, uuid.NewString(), uuid.NewString(), receipt)
			for index, state := range []string{"offered", "dispatching"} {
				id := uuid.NewString()
				raw, err := json.Marshal(map[string]any{"sessionId": session, "claimId": claim, "executionGeneration": "1", "operationId": id, "kind": "send_message", "protocol": "daynight.session.v1", "state": state})
				if err != nil {
					t.Fatal(err)
				}
				mustQueryExec(t, s, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,$3,'\x01','{}',$4,$5,'pat',$6)`, session, id, index+2, uuid.NewString(), uuid.NewString(), raw)
			}
			before := taskSessionTransitionFacts(t, s)
			var beforeEpoch string
			if err := s.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&beforeEpoch); err != nil {
				t.Fatal(err)
			}
			transition := func() error {
				return writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
					values := taskPropertyWriteValues(task)
					values.Status = status
					if _, err := tx.TaskDAO().UpdateTask(ctx, task.ID, values); err != nil {
						return err
					}
					if err := tx.SessionDAO().DrainTaskSessions(ctx, task.ID, TaskSessionDrain{
						SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle",
						RemoveFields:   []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
						SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"},
					}); err != nil {
						return err
					}
					return tx.SessionDAO().TransitionTaskSessionReceipts(ctx, task.ID, TaskSessionReceiptTransition{
						LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"},
					})
				})
			}
			for _, table := range []string{"task_sessions", "session_operations"} {
				mustQueryExec(t, s, `CREATE FUNCTION refuse_session_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'session write failure'; END $$`)
				mustQueryExec(t, s, `CREATE TRIGGER refuse_session_write BEFORE INSERT OR UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION refuse_session_write()`)
				if err := transition(); err == nil {
					t.Fatal("Task transition ignored the failed Session transaction")
				}
				if !reflect.DeepEqual(taskSessionTransitionFacts(t, s), before) {
					t.Fatal("failed freeze or receipt transition partially committed Task, Session or operation state")
				}
				mustQueryExec(t, s, `DROP TRIGGER refuse_session_write ON `+table)
				mustQueryExec(t, s, `DROP FUNCTION refuse_session_write()`)
			}
			if err := transition(); err != nil {
				t.Fatal(err)
			}
			after := snapshotTask(t, s, project.ID, task.ID)
			if after.Status != status || after.Ready || after.Version != task.Version+1 || status == model.TaskCancelled && (after.CancelledAt == nil || !after.CancelledAt.Equal(after.UpdatedAt)) {
				t.Fatalf("Task transition lost status, version or cancellation time: %+v", after)
			}
			unchanged := after
			unchanged.Status, unchanged.Version, unchanged.UpdatedAt, unchanged.Ready = task.Status, task.Version, task.UpdatedAt, task.Ready
			unchanged.CompletedAt, unchanged.CancelledAt = task.CompletedAt, task.CancelledAt
			if !reflect.DeepEqual(unchanged, task) {
				t.Fatalf("Task transition changed unrelated fields or execution history: %+v", after)
			}
			var epoch, lifecycle, state string
			if err := s.Pool.QueryRow(ctx, `SELECT task_cache_epoch::text FROM projects WHERE id=$1`, project.ID).Scan(&epoch); err != nil || epoch != beforeEpoch {
				t.Fatalf("Task transition replaced its cache epoch: %s %v", epoch, err)
			}
			if err := s.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle' FROM task_sessions WHERE id=$1`, session).Scan(&lifecycle); err != nil || lifecycle != "draining" {
				t.Fatal("Session not frozen", err)
			}
			if err := s.Pool.QueryRow(ctx, `SELECT receipt->>'state' FROM session_operations WHERE operation_id=$1`, operation).Scan(&state); err != nil || state != "rejected" {
				t.Fatal("undispatched operation not rejected", err)
			}
			var preserved int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM session_operations WHERE session_id=$1 AND receipt->>'state' IN ('offered','dispatching')`, session).Scan(&preserved); err != nil || preserved != 2 {
				t.Fatal("offered or dispatching operation changed", err)
			}
			var cleared bool
			var watermark int64
			if err := s.Pool.QueryRow(ctx, `SELECT NOT (snapshot ?| array['controls','cleanupInteractionIds','turnStartedAt','currentTurnId']), draining_timeline_seq FROM task_sessions WHERE id=$1`, session).Scan(&cleared, &watermark); err != nil || !cleared || watermark != 7 {
				t.Fatalf("Session controls or watermark: cleared=%v watermark=%d err=%v", cleared, watermark, err)
			}
			var events int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM session_events WHERE session_id=$1`, session).Scan(&events); err != nil || events != 0 {
				t.Fatal("claim transition persisted Session content", err)
			}
		})
	}
}

func TestTestSessionMigrationEnforcesScopeBindings(t *testing.T) {
	db := isolatedStore(t)
	ctx := context.Background()
	for _, sql := range []string{
		`INSERT INTO task_sessions(id,scope,owner_user_id,registration_id,registration,snapshot) VALUES(gen_random_uuid(),'test',gen_random_uuid(),gen_random_uuid(),'{}','{}')`,
		`INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot) VALUES(gen_random_uuid(),'task',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{}','{}')`,
		`INSERT INTO task_sessions(id,scope,test_execution_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES(gen_random_uuid(),'test',gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'{}','{}')`,
	} {
		if _, err := db.Pool.Exec(ctx, sql); err == nil {
			t.Fatal("invalid scope binding inserted")
		}
	}
}
