package usage_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/google/uuid"
)

func TestUsageLateReportsRemainWithOriginalClaimAfterNextClaimStarts(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, f.db.Pool, `UPDATE task_properties SET value=jsonb_set(value::jsonb,'{state}','"completed"')::text WHERE task_id=$1 AND name='worker'`, f.task)
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "1"))); err != nil {
		t.Fatal("completed original claim rejected late usage", err)
	}
	nextClaim := testutil.WorkerClaim(401, f.actor.UserID, uuid.NewString(), model.WorkerActive)
	nextClaim.Agent = model.AgentCopilot
	nextClaim.AgentControlMode = model.AgentControlModeWeb
	for name, raw := range testutil.TaskProperties(t, nextClaim) {
		testutil.PutTaskProperty(t, f.db.Pool, f.task, name, raw)
	}
	_, err = f.service.Register(ctx, f.actor, f.registration)
	requireCode(t, err, "registration_unavailable")
	next := f.registration
	next.StateID = uuid.NewString()
	next.RegistrationID = uuid.NewString()
	next.SessionID = uuid.NewString()
	next.NativeSessionID = "next-claim-native"
	next.ControllerInstanceID = uuid.NewString()
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: next.SessionID, ClaimID: nextClaim.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Identity: sp.Identity{Provider: "copilot", ControllerInstanceID: next.ControllerInstanceID, NativeSessionID: &next.NativeSessionID, WorkerID: nextClaim.WorkerID}, Lifecycle: "active"}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, f.db.Pool, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id,connection_parent_credential_id) VALUES($1,$2,$3,$4,$5,$6,'{}',$7,$8,$8)`, next.SessionID, f.project, f.task, nextClaim.ClaimID, f.actor.UserID, uuid.NewString(), raw, f.actor.CredentialID)
	current, err := f.service.Register(ctx, f.actor, next)
	if err != nil {
		t.Fatal(err)
	}
	before := testutil.CurrentTaskFacts(t, f.db.Pool)
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "2"))); err != nil {
		t.Fatal("new claim displaced original usage scope", err)
	}
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(current.State.ID, "3")))
	requireCode(t, err, "origin_unavailable")
	_, err = f.service.Batch(ctx, current.State.ID, current.Grant.Token, batch(measurement(reg.State.ID, "3")))
	requireCode(t, err, "origin_unavailable")
	page, err := f.service.Records(ctx, f.actor, f.project, f.task, "", app.PageRequest{Kind: "measurement", Limit: 100})
	if err != nil || len(page.Items) != 2 {
		t.Fatal(page, err)
	}
	for _, record := range page.Items {
		if record.SessionID != f.session || core.Value(record.ClaimID) != core.Value(reg.State.ClaimID) || core.Value(record.StateID) != reg.State.ID || core.Value(record.WorkerID) != core.Value(reg.State.WorkerID) {
			t.Fatal("late source rebound to new claim", record)
		}
	}
	if after := testutil.CurrentTaskFacts(t, f.db.Pool); !reflect.DeepEqual(before, after) {
		t.Fatal("usage changed Task facts")
	}
}

func TestUsageAuthorizationLocksRemainHeldWhileAwaitingFinalGrantGuard(t *testing.T) {
	f := workflow(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	holder, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	if _, err = holder.Exec(ctx, `SELECT id FROM usage_records WHERE id=$1 FOR UPDATE`, reg.State.ID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, e := f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "7")))
		result <- e
	}()
	pending := true
	defer func() {
		cancel()
		if pending {
			select {
			case <-result:
			case <-time.After(5 * time.Second):
				t.Error("usage write did not drain")
			}
		}
	}()
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT row_version::text FROM usage_records")
	for _, mutation := range []struct {
		query string
		id    string
	}{
		{`UPDATE personal_access_tokens SET expires_at=clock_timestamp() WHERE id=$1`, f.actor.CredentialID},
		{`UPDATE tasks SET allow_agents=false WHERE id=$1`, f.task},
		{`UPDATE project_ownership SET version=version+1 WHERE project_id=$1`, f.project},
	} {
		attempt, stop := context.WithTimeout(ctx, 100*time.Millisecond)
		_, e := f.db.Pool.Exec(attempt, mutation.query, mutation.id)
		stop()
		if !errors.Is(e, context.DeadlineExceeded) {
			t.Fatalf("authorization mutation crossed usage write: %s: %v", mutation.query, e)
		}
	}
	if err = holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	err = testutil.ReceiveQueryResult(t, ctx, result)
	pending = false
	if err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, f.db.Pool, `UPDATE personal_access_tokens SET expires_at=clock_timestamp() WHERE id=$1`, f.actor.CredentialID)
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "1")))
	requireCode(t, err, "permission_revoked")
	var count string
	if err = f.db.Pool.QueryRow(ctx, `SELECT count(*)::text FROM usage_records WHERE record_kind='measurement' AND session_id=$1`, f.session).Scan(&count); err != nil || count != "1" {
		t.Fatal(count, err)
	}
}
