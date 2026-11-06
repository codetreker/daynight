package postgres

import (
	"context"
	"encoding/json"
	"testing"
	"time"

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

func TestTaskSessionFreezeAndReceiptFailureRollBackTaskCompletion(t *testing.T) {
	ctx := context.Background()
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	queryTask(t, s, project.ID, 2, model.TaskInProgress)
	session, claim, operation := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snapshot := map[string]any{"sessionId": session, "claimId": claim, "executionGeneration": "1", "connectionEpoch": "1", "sessionRevision": "1", "lastEventSeq": "0", "historyEpoch": uuid.NewString(), "lifecycle": "active", "lastTimelineSeq": "7", "controls": []any{"control"}, "cleanupInteractionIds": []any{"cleanup"}, "turnStartedAt": "2026-01-01T00:00:00Z", "currentTurnId": "turn"}
	raw, _ := json.Marshal(snapshot)
	receipt, _ := json.Marshal(map[string]any{"sessionId": session, "claimId": claim, "executionGeneration": "1", "operationId": operation, "kind": "send_message", "protocol": "daynight.session.v1", "state": "accepted", "providerResult": nil, "error": nil})
	mustQueryExec(t, s, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, session, project.ID, queryID(2), claim, uuid.NewString(), uuid.NewString(), raw)
	mustQueryExec(t, s, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,1,'\x01','{}',$3,$4,'pat',$5)`, session, operation, uuid.NewString(), uuid.NewString(), receipt)
	for i, state := range []string{"offered", "dispatching"} {
		id := uuid.NewString()
		raw, _ := json.Marshal(map[string]any{"sessionId": session, "claimId": claim, "executionGeneration": "1", "operationId": id, "kind": "send_message", "protocol": "daynight.session.v1", "state": state})
		mustQueryExec(t, s, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,$3,'\x01','{}',$4,$5,'pat',$6)`, session, id, i+2, uuid.NewString(), uuid.NewString(), raw)
	}
	complete := func() error {
		return writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
			_, err := tx.TaskDAO().UpdateTask(ctx, queryID(2), TaskWrite{Title: "Completed", Status: model.TaskDone, Properties: fixtureTaskProperties(t, nil)})
			if err != nil {
				return err
			}
			if err := tx.SessionDAO().DrainTaskSessions(ctx, queryID(2), TaskSessionDrain{
				SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle",
				RemoveFields:   []string{"cleanupInteractionIds", "controls", "turnStartedAt", "currentTurnId"},
				SnapshotValues: map[string]any{"lifecycle": "draining", "synchronized": false, "connectionState": "disconnected", "activity": "unknown"},
			}); err != nil {
				return err
			}
			return tx.SessionDAO().TransitionTaskSessionReceipts(ctx, queryID(2), TaskSessionReceiptTransition{
				LifecycleField: "lifecycle", Lifecycle: "draining", StateField: "state", PreviousState: "accepted", NextState: "rejected", RemoveFields: []string{"error"},
			})
		})
	}
	for _, table := range []string{"task_sessions", "session_operations"} {
		mustQueryExec(t, s, `CREATE FUNCTION refuse_session_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'session write failure'; END $$`)
		mustQueryExec(t, s, `CREATE TRIGGER refuse_session_write BEFORE INSERT OR UPDATE ON `+table+` FOR EACH ROW EXECUTE FUNCTION refuse_session_write()`)
		if err := complete(); err == nil {
			t.Fatal("task completion ignored failed session transaction")
		}
		var status string
		if err := s.Pool.QueryRow(ctx, `SELECT status FROM tasks WHERE id=$1`, queryID(2)).Scan(&status); err != nil || status != "in_progress" {
			t.Fatal("task committed without its session fence", err)
		}
		mustQueryExec(t, s, `DROP TRIGGER refuse_session_write ON `+table)
		mustQueryExec(t, s, `DROP FUNCTION refuse_session_write()`)
	}
	if err := complete(); err != nil {
		t.Fatal(err)
	}
	var lifecycle, state string
	var events int
	if err := s.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle' FROM task_sessions WHERE id=$1`, session).Scan(&lifecycle); err != nil || lifecycle != "draining" {
		t.Fatal("session not frozen", err)
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
		t.Fatalf("session controls or watermark: cleared=%v watermark=%d err=%v", cleared, watermark, err)
	}
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM session_events WHERE session_id=$1`, session).Scan(&events); err != nil || events != 0 {
		t.Fatal("claim transition persisted session content", err)
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

func TestDrainTaskSessionsPreservesActiveClaim(t *testing.T) {
	ctx := context.Background()
	s := isolatedStore(t)
	project := queryProject(t, s, 1)
	task := queryTask(t, s, project.ID, 2, model.TaskInProgress)
	activeClaim, staleClaim := uuid.NewString(), uuid.NewString()
	activeSession, staleSession := uuid.NewString(), uuid.NewString()
	for _, item := range []struct{ session, claim string }{{activeSession, activeClaim}, {staleSession, staleClaim}} {
		raw, _ := json.Marshal(map[string]any{"lifecycle": "active", "lastTimelineSeq": "3"})
		mustQueryExec(t, s, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, item.session, project.ID, task.ID, item.claim, uuid.NewString(), uuid.NewString(), raw)
	}
	var before time.Time
	if err := s.Pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := writeProjectForTest(s, ctx, project.ID, func(tx ProjectWriteScope) error {
		return tx.SessionDAO().DrainTaskSessions(ctx, task.ID, TaskSessionDrain{
			ActiveClaim: &activeClaim, SourceLifecycle: "active", GraceSeconds: 60, TimelineField: "lastTimelineSeq", LifecycleField: "lifecycle",
			RemoveFields: []string{"controls"}, SnapshotValues: map[string]any{"lifecycle": "draining"},
		})
	}); err != nil {
		t.Fatal(err)
	}
	var after time.Time
	if err := s.Pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&after); err != nil {
		t.Fatal(err)
	}
	var active, stale string
	var deadline time.Time
	if err := s.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle' FROM task_sessions WHERE id=$1`, activeSession).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if err := s.Pool.QueryRow(ctx, `SELECT snapshot->>'lifecycle', draining_until FROM task_sessions WHERE id=$1`, staleSession).Scan(&stale, &deadline); err != nil {
		t.Fatal(err)
	}
	if active != "active" || stale != "draining" || deadline.Before(before.Add(time.Minute)) || deadline.After(after.Add(time.Minute)) {
		t.Fatalf("active=%s stale=%s before=%v deadline=%v after=%v", active, stale, before, deadline, after)
	}
}
