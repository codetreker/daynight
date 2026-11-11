package session_test

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
)

func testProjectRetirementBatchesAndRollback(t *testing.T, db *postgres.Store) {
	ctx := t.Context()
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	owner := uuid.NewString()
	web := uuid.NewString()
	terminal := uuid.NewString()
	_, err := db.Pool.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) SELECT gen_random_uuid(),$1,$2,gen_random_uuid(),$3,gen_random_uuid(),'{}','{"lifecycle":"active"}' FROM generate_series(1,129)`, project.ID, task.ID, owner)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,grant_hash,grant_expires_at,connection_expires_at) VALUES($1,$2,$3,$4,$5,$6,'{}','{"lifecycle":"active","controls":{"x":1}}','abc',now()+interval '1 hour',now()+interval '1 hour')`, web, project.ID, task.ID, uuid.NewString(), owner, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,backend,terminal_state) VALUES($1,$2,$3,$4,$5,$6,'{}',NULL,'herdr','{"ControlEpoch":"4","Control":{"connectionEpoch":"2","controlEpoch":"4","state":"manual","availableActions":["acquire_control"]},"ControlActor":{"UserID":"x"},"LastLeaseSeq":"4"}')`, terminal, project.ID, task.ID, uuid.NewString(), owner, uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	for i, state := range []string{"accepted", "offered", "dispatching", "confirmed"} {
		_, err = db.Pool.Exec(ctx, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,$3,'x','{}',$4,$5,'session',jsonb_build_object('state',$6::text))`, web, uuid.NewString(), i+1, owner, uuid.NewString(), state)
		if err != nil {
			t.Fatal(err)
		}
	}
	for i, state := range []string{"queued", "dispatching", "confirmed"} {
		_, err = db.Pool.Exec(ctx, `INSERT INTO session_operations(session_id,operation_id,operation_seq,body_hash,command,actor_user_id,credential_id,credential_kind,receipt) VALUES($1,$2,$3,'x','{}',$4,$5,'session',jsonb_build_object('state',$6::text))`, terminal, uuid.NewString(), i+1, owner, uuid.NewString(), state)
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, commit := range []bool{false, true} {
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer rollbackSessionTestTransaction(t, tx)
		if err = sessioncore.RetireProject(ctx, pgsession.NewProjectRetirementDAO(tx, project.ID), project.ID); err != nil {
			t.Fatal(err)
		}
		if commit {
			err = tx.Commit(ctx)
		} else {
			err = tx.Rollback(ctx)
		}
		if err != nil {
			t.Fatal(err)
		}
		var count int
		err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE project_id=$1 AND snapshot->>'lifecycle'='draining'`, project.ID).Scan(&count)
		if err != nil {
			t.Fatal(err)
		}
		if !commit && count != 0 || commit && count != 130 {
			t.Fatalf("commit=%v: %d retired", commit, count)
		}
	}
	var grantCleared, controlRetired bool
	err = db.Pool.QueryRow(ctx, `SELECT grant_hash IS NULL AND grant_expires_at IS NULL AND connection_expires_at IS NULL AND snapshot->'controls' IS NULL FROM task_sessions WHERE id=$1`, web).Scan(&grantCleared)
	if err != nil || !grantCleared {
		t.Fatalf("web grant: %v %v", grantCleared, err)
	}
	err = db.Pool.QueryRow(ctx, `SELECT terminal_state->>'ControlEpoch'='5' AND terminal_state->'Control'->>'state'='suspended' AND terminal_state->'ControlActor'='null'::jsonb FROM task_sessions WHERE id=$1`, terminal).Scan(&controlRetired)
	if err != nil || !controlRetired {
		t.Fatalf("terminal: %v %v", controlRetired, err)
	}
	for sessionID, want := range map[string][]string{web: {"rejected", "unknown", "unknown", "confirmed"}, terminal: {"rejected", "unknown", "confirmed"}} {
		rows, err := db.Pool.Query(ctx, `SELECT receipt->>'state' FROM session_operations WHERE session_id=$1 ORDER BY operation_seq`, sessionID)
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		i := 0
		for rows.Next() {
			var got string
			if err = rows.Scan(&got); err != nil {
				t.Fatal(err)
			}
			if got != want[i] {
				t.Fatalf("operation %d: %s want %s", i, got, want[i])
			}
			i++
		}
		rows.Close()
		if rows.Err() != nil || i != len(want) {
			t.Fatalf("receipt read: %v %d", rows.Err(), i)
		}
	}
}
