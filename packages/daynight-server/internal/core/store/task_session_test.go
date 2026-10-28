package store

import (
	"context"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
	"testing"
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
	queryTask(t, s, project.ID, 2, core.TaskInProgress)
	session, claim, operation := uuid.NewString(), uuid.NewString(), uuid.NewString()
	snapshot := map[string]any{"sessionId": session, "claimId": claim, "executionGeneration": "1", "connectionEpoch": "1", "sessionRevision": "1", "lastEventSeq": "0", "historyEpoch": uuid.NewString(), "lifecycle": "active"}
	raw, _ := json.Marshal(snapshot)
	receipt, _ := json.Marshal(map[string]any{"sessionId": session, "claimId": claim, "executionGeneration": "1", "operationId": operation, "kind": "send_message", "protocol": "daynight.session.v1", "state": "accepted", "providerResult": nil, "error": nil})
	mustQueryExec(t, s, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$4,$5,$6,'{}',$7)`, session, project.ID, queryID(2), claim, uuid.NewString(), uuid.NewString(), raw)
	mustQueryExec(t, s, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,1,'\x01','{}',$3,$4,'pat',$5)`, session, operation, uuid.NewString(), uuid.NewString(), receipt)
	complete := func() error {
		return s.WriteProject(ctx, project.ID, func(tx *ProjectTx) error {
			_, err := tx.UpdateTask(ctx, queryID(2), TaskWrite{Title: "Completed", Status: core.TaskDone, Properties: core.TaskProperties{PullRequests: []core.PullRequestProperty{}}})
			return err
		})
	}
	for _, table := range []string{"session_events", "session_operations"} {
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
	if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM session_events WHERE session_id=$1`, session).Scan(&events); err != nil || events != 2 {
		t.Fatal("freeze/operation outbox is incomplete", err)
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
