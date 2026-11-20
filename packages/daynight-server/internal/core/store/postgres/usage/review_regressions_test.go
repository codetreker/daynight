package usage_test

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/google/uuid"
)

func standaloneUsageWorkflow(t *testing.T) *workflowFixture {
	t.Helper()
	f := workflow(t)
	f.session = uuid.NewString()
	f.registration.SessionID = f.session
	execution := uuid.NewString()
	snapshot := sp.Snapshot{
		ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: f.session, TestExecutionID: execution, ExecutionGeneration: "1"}, ConnectionEpoch: "1"},
		Identity:        sp.Identity{Provider: "copilot", ControllerInstanceID: f.registration.ControllerInstanceID, NativeSessionID: &f.registration.NativeSessionID},
		Lifecycle:       "active",
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, f.db.Pool, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id,connection_parent_credential_id) VALUES($1,'test',$2,$3,$4,'{}',$5,$6,$6)`, f.session, execution, f.actor.UserID, uuid.NewString(), raw, f.actor.CredentialID)
	return f
}

func advanceUsageGeneration(t *testing.T, f *workflowFixture) app.RegistrationResult {
	t.Helper()
	next := f.registration
	next.StateID, next.RegistrationID, next.ControllerInstanceID = uuid.NewString(), uuid.NewString(), uuid.NewString()
	next.Generation, next.ConnectionEpoch = "2", "2"
	proof, err := json.Marshal(sp.StopProof{RecordID: uuid.NewString(), PreviousControllerInstanceID: f.registration.ControllerInstanceID, StoppedAt: time.Now().UTC().Format(time.RFC3339Nano)})
	if err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET stop_proof=$2,snapshot=jsonb_set(jsonb_set(jsonb_set(snapshot,'{executionGeneration}','"2"'),'{connectionEpoch}','"2"'),'{identity,controllerInstanceId}',to_jsonb($3::text)) WHERE id=$1`, f.session, proof, next.ControllerInstanceID)
	reg, err := f.service.Register(t.Context(), f.actor, next)
	if err != nil {
		t.Fatal(err)
	}
	return reg
}

func requireUsageReasons(t *testing.T, reasons []string, required ...string) {
	t.Helper()
	for _, want := range required {
		found := false
		for _, got := range reasons {
			found = found || got == want
		}
		if !found {
			t.Fatalf("missing %s in %v", want, reasons)
		}
	}
}

func replacementUsageParent(t *testing.T, f *workflowFixture) model.Principal {
	t.Helper()
	ctx := t.Context()
	reader := f.actor
	reader.CredentialID = uuid.NewString()
	hash := sha256.Sum256([]byte(uuid.NewString()))
	testutil.MustExec(t, f.db.Pool, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'reconnect parent',clock_timestamp())`, reader.CredentialID, reader.UserID, hash[:])
	reconnect, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer reconnect.Rollback(context.Background())
	err = pgsession.New(reconnect).SetSessionGrant(ctx, store.SessionGrant{SessionID: f.session, Hash: hash[:], Kind: "reconnect", ParentCredentialID: reader.CredentialID, ExpiresAt: time.Now().Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if err = reconnect.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return reader
}

func TestUsageStandaloneBatchPreservesTestRegistrationUserSessionLockOrder(t *testing.T) {
	f := standaloneUsageWorkflow(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := f.db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer replay.Rollback(context.Background())
	dao := pgsession.New(replay)
	if err = dao.LockCredential(ctx, f.actor, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err = dao.LockTestOwner(ctx, f.actor.UserID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "7")))
		result <- err
	}()
	pending := true
	defer func() {
		cancel()
		if pending {
			select {
			case <-result:
			case <-time.After(5 * time.Second):
				t.Error("usage batch did not drain")
			}
		}
	}()
	testutil.WaitForQueryLock(t, f.db.Pool, "SELECT p.id::text FROM personal_access_tokens p JOIN users")
	// registerTest acquires these production DAO locks in credential/owner/Session order.
	if _, err = dao.LockSession(ctx, f.session); err != nil {
		t.Fatal("usage acquired the Session before the registration owner's lock", err)
	}
	if err = replay.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	err = testutil.ReceiveQueryResult(t, ctx, result)
	pending = false
	if err != nil {
		t.Fatal(err)
	}
	summary, err := f.service.TestSummary(ctx, f.actor, f.session)
	if err != nil || core.Value(summary.Metrics["outputTokens"].Known) != "7" {
		t.Fatal(summary, err)
	}
}

func TestUsageCoverageRetainsEachStatesOriginalParentAfterReconnect(t *testing.T) {
	for _, known := range []bool{false, true} {
		name := "unknown"
		if known {
			name = "known"
		}
		t.Run(name, func(t *testing.T) {
			f := workflow(t)
			ctx := t.Context()
			reg, err := f.service.Register(ctx, f.actor, f.registration)
			if err != nil {
				t.Fatal(err)
			}
			if known {
				if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "7"))); err != nil {
					t.Fatal(err)
				}
			}
			reader := replacementUsageParent(t, f)
			testutil.MustExec(t, f.db.Pool, `DELETE FROM personal_access_tokens WHERE id=$1`, f.actor.CredentialID)
			_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "1")))
			requireCode(t, err, "permission_revoked")
			want := "unavailable"
			if known {
				want = "partial"
			}
			state, err := f.service.State(ctx, reader, reg.State.ID)
			if err != nil || core.Value(state.EffectiveCollectionState) != want {
				t.Fatal(state, err)
			}
			requireUsageReasons(t, state.ReasonCodes, "permission_revoked", "missing_final")
			page, err := f.service.Records(ctx, reader, f.project, f.task, "", app.PageRequest{Kind: "execution_state", Limit: 100})
			if err != nil || len(page.Items) != 1 || core.Value(page.Items[0].EffectiveCollectionState) != want {
				t.Fatal(page, err)
			}
			requireUsageReasons(t, page.Items[0].ReasonCodes, "permission_revoked", "missing_final")
			summary, err := f.service.TaskSummaries(ctx, reader, f.project, []string{f.task})
			if err != nil || summary.Items[0].Summary.Completeness != want {
				t.Fatal(summary, err)
			}
			requireUsageReasons(t, summary.Items[0].Summary.ReasonCodes, "permission_revoked", "missing_final")
			group, err := f.service.Aggregate(ctx, reader, f.project, "chain", f.task, "")
			if err != nil || group.Summary.Completeness != want {
				t.Fatal(group, err)
			}
			goal := uuid.NewString()
			testutil.MustExec(t, f.db.Pool, `INSERT INTO tasks(id,project_id,type,title,description,status) VALUES($1,$2,'goal','Goal','','todo')`, goal, f.project)
			testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET parent_id=$1 WHERE id=$2`, goal, f.task)
			group, err = f.service.Aggregate(ctx, reader, f.project, "goal", goal, "")
			if err != nil || group.Summary.Completeness != want {
				t.Fatal(group, err)
			}
			f.actor = reader
			testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET connection_parent_credential_id=$2 WHERE id=$1`, f.session, reader.CredentialID)
			current := advanceUsageGeneration(t, f)
			currentState, err := f.service.State(ctx, reader, current.State.ID)
			if err != nil || core.Value(currentState.EffectiveCollectionState) != "collecting" {
				t.Fatal("original parent revocation contaminated the new parent's state", currentState, err)
			}
			if _, err = f.service.Batch(ctx, current.State.ID, current.Grant.Token, batch(measurement(current.State.ID, "1"))); err != nil {
				t.Fatal("valid replacement parent cannot upload its own state", err)
			}
			_, err = f.service.Batch(ctx, current.State.ID, current.Grant.Token, batch(measurement(reg.State.ID, "1")))
			requireCode(t, err, "origin_unavailable")
		})
	}
}

func TestUsageStandaloneProjectionKeepsOriginalParentAfterReconnect(t *testing.T) {
	f := standaloneUsageWorkflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	reader := replacementUsageParent(t, f)
	testutil.MustExec(t, f.db.Pool, `DELETE FROM personal_access_tokens WHERE id=$1`, f.actor.CredentialID)
	summary, err := f.service.TestSummary(ctx, reader, f.session)
	if err != nil || summary.Completeness != "unavailable" {
		t.Fatal(summary, err)
	}
	requireUsageReasons(t, summary.ReasonCodes, "permission_revoked", "missing_final")
	page, err := f.service.Records(ctx, reader, "", "", f.session, app.PageRequest{Kind: "execution_state", Limit: 100})
	if err != nil || len(page.Items) != 1 || page.Items[0].ID != reg.State.ID {
		t.Fatal(page, err)
	}
	requireUsageReasons(t, page.Items[0].ReasonCodes, "permission_revoked", "missing_final")
}

func TestUsageSupersededGenerationStopsCoverageWithoutRevokingLateReports(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	old, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	current := advanceUsageGeneration(t, f)
	if _, err = f.service.Batch(ctx, current.State.ID, current.Grant.Token, batch(stateEvent(current.State, "1", "partial", true))); err != nil {
		t.Fatal(err)
	}
	state, err := f.service.State(ctx, f.actor, old.State.ID)
	if err != nil || core.Value(state.EffectiveCollectionState) != "unavailable" {
		t.Fatal(state, err)
	}
	requireUsageReasons(t, state.ReasonCodes, "collector_failed", "missing_final")
	summary, err := f.service.TaskSummaries(ctx, f.actor, f.project, []string{f.task})
	if err != nil || summary.Items[0].Summary.Completeness == "collecting" {
		t.Fatal(summary, err)
	}
	group, err := f.service.Aggregate(ctx, f.actor, f.project, "chain", f.task, "")
	if err != nil || group.Summary.Completeness == "collecting" {
		t.Fatal(group, err)
	}
	late := measurement(old.State.ID, "7")
	if _, err = f.service.Batch(ctx, old.State.ID, old.Grant.Token, batch(late)); err != nil {
		t.Fatal("confirmed stop incorrectly revoked original late-report grant", err)
	}
	sources, err := f.service.Sources(ctx, current.State.ID, current.Grant.Token, []string{late.SourceKey})
	if err != nil || len(sources.Items) != 1 || sources.Items[0].OriginatingStateID != old.State.ID {
		t.Fatal("late source left its original generation", sources, err)
	}
}

type fixedUsageReadClock struct {
	store.UsageStore
	now *time.Time
}

type fixedUsageClockScope struct {
	store.UsageScope
	now time.Time
}

type fixedUsageClockDAO struct {
	store.UsageDAO
	now time.Time
}

func (s fixedUsageReadClock) ReadUsage(ctx context.Context, f func(store.UsageScope) error) error {
	return s.UsageStore.ReadUsage(ctx, func(scope store.UsageScope) error {
		return f(fixedUsageClockScope{scope, *s.now})
	})
}
func (s fixedUsageClockScope) UsageDAO() store.UsageDAO {
	return fixedUsageClockDAO{s.UsageScope.UsageDAO(), s.now}
}
func (s fixedUsageClockDAO) Now(context.Context) (time.Time, error) { return s.now, nil }

func TestUsageStatePaginationBindsDerivedProjectionButNotObservationClock(t *testing.T) {
	for _, kind := range []string{"execution_state", "", "measurement"} {
		t.Run("kind="+kind, func(t *testing.T) {
			f := workflow(t)
			ctx := t.Context()
			reg, err := f.service.Register(ctx, f.actor, f.registration)
			if err != nil {
				t.Fatal(err)
			}
			advanceUsageGeneration(t, f)
			if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "1"), measurement(reg.State.ID, "2"))); err != nil {
				t.Fatal(err)
			}
			now := time.Now().UTC()
			reader, err := app.New(fixedUsageReadClock{f.db, &now}, app.Options{})
			if err != nil {
				t.Fatal(err)
			}
			filter := app.PageRequest{Kind: kind, Limit: 1}
			first, err := reader.Records(ctx, f.actor, f.project, f.task, "", filter)
			if err != nil || first.NextCursor == nil {
				t.Fatal(first, err)
			}
			filter.Cursor = *first.NextCursor
			now = now.Add(time.Second)
			second, err := reader.Records(ctx, f.actor, f.project, f.task, "", filter)
			if err != nil || second.SnapshotToken != first.SnapshotToken {
				t.Fatal("observation time alone invalidated cursor", second, err)
			}
			testutil.PutTaskProperty(t, f.db.Pool, f.task, "blocked", []byte("true"))
			second, err = reader.Records(ctx, f.actor, f.project, f.task, "", filter)
			if kind == "measurement" {
				if err != nil || second.SnapshotToken != first.SnapshotToken {
					t.Fatal("pause invalidated measurement-only ledger page", second, err)
				}
			} else {
				requireCode(t, err, "reset_required")
				filter.Cursor = ""
				updated, err := reader.Records(ctx, f.actor, f.project, f.task, "", filter)
				if err != nil || updated.SnapshotToken == first.SnapshotToken {
					t.Fatal(updated, err)
				}
			}
		})
	}
}

func TestUsageRetainedStateProjectionUsesRevokedScopeAfterSessionDeletion(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "12"))); err != nil {
		t.Fatal(err)
	}
	advanceUsageGeneration(t, f)
	testutil.MustExec(t, f.db.Pool, `DELETE FROM task_sessions WHERE id=$1`, f.session)
	if err := f.db.ReadUsage(ctx, func(scope store.UsageScope) error {
		executions, err := scope.UsageDAO().Executions(ctx, store.UsageFilter{ProjectID: f.project, TaskIDs: []string{f.task}})
		if err == nil {
			if len(executions) != 2 {
				t.Fatal("retained states disappeared from projection", executions)
			}
			for _, execution := range executions {
				if execution.State == nil || execution.Allowed || !execution.ParentValid || !execution.Known || core.Value(execution.TaskID) != f.task {
					t.Fatal("retained state inherited a live execution scope", execution)
				}
			}
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	page, err := f.service.Records(ctx, f.actor, f.project, f.task, "", app.PageRequest{Limit: 100})
	if err != nil || len(page.Items) != 3 {
		t.Fatal(page, err)
	}
	for _, state := range page.Items {
		if state.Kind != "execution_state" {
			continue
		}
		if core.Value(state.EffectiveCollectionState) != "partial" {
			t.Fatal(state)
		}
		requireUsageReasons(t, state.ReasonCodes, "permission_revoked", "missing_final")
	}
}

func TestUsageStatePaginationResetsAtOriginalParentExpiryUsingProjectionClock(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	advanceUsageGeneration(t, f)
	principal := replacementUsageParent(t, f)
	now := time.Now().UTC()
	expiry := now.Add(time.Minute)
	testutil.MustExec(t, f.db.Pool, `UPDATE personal_access_tokens SET expires_at=$2 WHERE id=$1`, f.actor.CredentialID, expiry)
	reader, err := app.New(fixedUsageReadClock{f.db, &now}, app.Options{})
	if err != nil {
		t.Fatal(err)
	}
	filter := app.PageRequest{Kind: "execution_state", Limit: 1}
	first, err := reader.Records(ctx, principal, f.project, f.task, "", filter)
	if err != nil || first.NextCursor == nil || first.Items[0].ID != reg.State.ID {
		t.Fatal(first, err)
	}
	filter.Cursor = *first.NextCursor
	now = expiry
	_, err = reader.Records(ctx, principal, f.project, f.task, "", filter)
	requireCode(t, err, "reset_required")
	filter.Cursor = ""
	updated, err := reader.Records(ctx, principal, f.project, f.task, "", filter)
	if err != nil || updated.SnapshotToken == first.SnapshotToken || len(updated.Items) != 1 {
		t.Fatal(updated, err)
	}
	requireUsageReasons(t, updated.Items[0].ReasonCodes, "permission_revoked", "missing_final")
	for _, reason := range updated.Items[0].ReasonCodes {
		if reason == "upload_expired" {
			t.Fatal("original parent expiry was confused with usage grant expiry")
		}
	}
}

func TestUsageStatePaginationResetsAtNaturalGrantExpiryInOneOperationClock(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	advanceUsageGeneration(t, f)
	now := time.Now().UTC()
	expiry := now.Add(time.Minute)
	testutil.MustExec(t, f.db.Pool, `UPDATE usage_records SET grant_expires_at=$2 WHERE id=$1`, reg.State.ID, expiry)
	reader, err := app.New(fixedUsageReadClock{f.db, &now}, app.Options{})
	if err != nil {
		t.Fatal(err)
	}
	filter := app.PageRequest{Kind: "execution_state", Limit: 1}
	first, err := reader.Records(ctx, f.actor, f.project, f.task, "", filter)
	if err != nil || first.NextCursor == nil {
		t.Fatal(first, err)
	}
	filter.Cursor = *first.NextCursor
	now = expiry
	_, err = reader.Records(ctx, f.actor, f.project, f.task, "", filter)
	requireCode(t, err, "reset_required")
	filter.Cursor = ""
	updated, err := reader.Records(ctx, f.actor, f.project, f.task, "", filter)
	if err != nil || updated.SnapshotToken == first.SnapshotToken || len(updated.Items) != 1 {
		t.Fatal(updated, err)
	}
	requireUsageReasons(t, updated.Items[0].ReasonCodes, "upload_expired", "missing_final")
}
