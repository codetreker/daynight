package usage_test

import (
	"crypto/sha256"
	"encoding/json"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/usage"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
	"github.com/google/uuid"
)

type workflowFixture struct {
	db                     *postgres.Store
	service                *app.Service
	actor                  model.Principal
	project, task, session string
	registration           app.Registration
}

func workflow(t *testing.T) *workflowFixture {
	t.Helper()
	return workflowInStore(t, testutil.OpenStore(t, postgres.Open), 400)
}

func workflowInStore(t *testing.T, db *postgres.Store, number int) *workflowFixture {
	t.Helper()
	owner, _, project := testutil.ProjectMembershipFixture(t, db)
	task := testutil.QueryTask(t, db, project.ID, number, model.TaskInProgress)
	patID := uuid.NewString()
	hash := sha256.Sum256([]byte(patID))
	testutil.MustExec(t, db.Pool, `INSERT INTO personal_access_tokens(business_scopes,scope_version,id,user_id,token_hash,name,created_at) VALUES(ARRAY['attachment:delete','attachment:read','attachment:upload','session:control','session:produce','session:read','session:send','task:read','thread:post','thread:read','usage:read'],1,$1,$2,$3,'usage fixture',clock_timestamp())`, patID, owner.UserID, hash[:])
	owner.Kind = model.PATCredential
	owner.CredentialID = patID
	claim := testutil.WorkerClaim(number, owner.UserID, uuid.NewString(), model.WorkerActive)
	claim.Agent = model.AgentCopilot
	claim.AgentControlMode = model.AgentControlModeWeb
	for name, raw := range testutil.TaskProperties(t, claim) {
		testutil.PutTaskProperty(t, db.Pool, task.ID, name, raw)
	}
	testutil.MustExec(t, db.Pool, `UPDATE tasks SET allow_agents=true WHERE id=$1`, task.ID)
	sessionID := uuid.NewString()
	native := "native-fixture-" + sessionID
	instance := uuid.NewString()
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: sessionID, ClaimID: claim.ClaimID, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Identity: sp.Identity{Provider: "copilot", ControllerInstanceID: instance, NativeSessionID: &native, WorkerID: claim.WorkerID}, Lifecycle: "active"}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, db.Pool, `INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id,connection_parent_credential_id) VALUES($1,$2,$3,$4,$5,$6,'{}',$7,$8,$8)`, sessionID, project.ID, task.ID, claim.ClaimID, owner.UserID, uuid.NewString(), raw, patID)
	input := app.Registration{Protocol: core.Protocol, StateID: uuid.NewString(), SessionID: sessionID, Generation: "1", ControllerInstanceID: instance, ConnectionEpoch: "1", NativeSessionID: native, ProfileID: "copilot-event-1.0.11-v1", ProviderVersion: "isolated-fixture", RegistrationID: uuid.NewString()}
	service, err := app.New(db, app.Options{WriteEnabled: true, QualifiedProfiles: []string{input.ProfileID + "@" + input.ProviderVersion}})
	if err != nil {
		t.Fatal(err)
	}
	return &workflowFixture{db: db, actor: owner, project: project.ID, task: task.ID, session: sessionID, registration: input, service: service}
}
func measurement(state string, output string) model.UsageEvent {
	return model.UsageEvent{EventID: uuid.NewString(), Kind: "measurement", OriginatingStateID: state, SourceKey: "copilot-event-v1:" + uuid.NewString(), Model: core.Ptr("fixture-model"), ProfileID: "copilot-event-1.0.11-v1", RevisionAuthority: "immutable", SourceRevision: "1", Finality: "final", Disposition: "active", AggregationRole: "counted", Metrics: model.UsageMetrics{Output: core.Ptr(output)}, NativeMetrics: map[string]any{"outputTokens": output}, ReasonCodes: []string{}, ObservedAt: time.Now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano)}
}
func batch(events ...model.UsageEvent) app.Batch {
	return app.Batch{Protocol: core.Protocol, BatchID: uuid.NewString(), Events: events}
}
func requireCode(t *testing.T, err error, code string) {
	t.Helper()
	var fault *model.UsageFault
	if !errors.As(err, &fault) || fault.Error() != code {
		t.Fatalf("wanted %s; got %v", code, err)
	}
}
func TestUsageWorkflowPersistenceLateReportAndStickyConflict(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	before := testutil.CurrentTaskFacts(t, f.db.Pool)
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil || !reg.Created || reg.Grant == nil {
		t.Fatal(reg, err)
	}
	replay, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil || replay.Grant != nil || replay.Created {
		t.Fatal(replay, err)
	}
	event := measurement(reg.State.ID, "9007199254740993")
	for i := 0; i < 10; i++ {
		result, e := f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(event))
		if e != nil {
			t.Fatal(e)
		}
		want := "duplicate"
		if i == 0 {
			want = "inserted"
		}
		if len(result.Results) != 1 || result.Results[0].Outcome != want {
			t.Fatal(result)
		}
	}
	second := measurement(reg.State.ID, "7")
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(second)); err != nil {
		t.Fatal(err)
	}
	summaries, err := f.service.TaskSummaries(ctx, f.actor, f.project, []string{f.task})
	if err != nil {
		t.Fatal(err)
	}
	summary := summaries.Items[0].Summary
	if core.Value(summary.Metrics["outputTokens"].Known) != "9007199254741000" || summary.Metrics["totalTokens"].Known != nil || summary.MeasurementRecords != "2" {
		t.Fatalf("%+v", summary)
	}
	page, err := f.service.Records(ctx, f.actor, f.project, f.task, "", app.PageRequest{Kind: "measurement", Limit: 1})
	if err != nil || page.NextCursor == nil || len(page.Items) != 1 {
		t.Fatal(page, err)
	}
	source, err := f.service.Sources(ctx, reg.State.ID, reg.Grant.Token, []string{event.SourceKey, "missing"})
	if err != nil || len(source.Items) != 1 || len(source.MissingKeys) != 1 {
		t.Fatal(source, err)
	}
	if got := testutil.CurrentTaskFacts(t, f.db.Pool); !reflect.DeepEqual(got, before) {
		t.Fatal("usage mutated Task")
	}
	// A business completion is not a revocation of this original Session grant.
	testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET status='done' WHERE id=$1`, f.task)
	third := measurement(reg.State.ID, "0")
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(third)); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Records(ctx, f.actor, f.project, f.task, "", app.PageRequest{Kind: "measurement", Limit: 1, Cursor: *page.NextCursor})
	requireCode(t, err, "reset_required")
	conflict := event
	conflict.Metrics.Output = core.Ptr("1")
	conflict.NativeMetrics = map[string]any{"outputTokens": "1"}
	unrelated := measurement(reg.State.ID, "999")
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(unrelated, conflict))
	requireCode(t, err, "source_conflict")
	var diagnostic *model.UsageFault
	if !errors.As(err, &diagnostic) || !diagnostic.DiagnosticCommitted {
		t.Fatal(err)
	}
	observed, err := f.service.State(ctx, f.actor, reg.State.ID)
	if err != nil || core.Value(observed.CollectionState) != "partial" {
		t.Fatal(observed, err)
	}
	source, err = f.service.Sources(ctx, reg.State.ID, reg.Grant.Token, []string{event.SourceKey, unrelated.SourceKey})
	if err != nil || len(source.Items) != 1 || len(source.MissingKeys) != 1 {
		t.Fatal(source, err)
	}
	if source.Items[0].BodyHash == "" || source.Items[0].RowVersion != "1" {
		t.Fatal("conflict overwrote source", source)
	}
	testutil.MustExec(t, f.db.Pool, `UPDATE tasks SET allow_agents=false WHERE id=$1`, f.task)
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "2")))
	requireCode(t, err, "permission_revoked")
	if _, err = f.service.TaskSummaries(ctx, f.actor, f.project, []string{f.task}); err != nil {
		t.Fatal("history unavailable", err)
	}
}
func TestUsageRotationRevocationAndOriginBinding(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	finishUsageRotation(t, f, reg)
}
func stateEvent(state model.UsageRecord, sequence, stateName string, seal bool) model.UsageEvent {
	reasons := []string{}
	if stateName == "partial" {
		reasons = core.ProfileReasons(state.Provider)
	}
	return model.UsageEvent{EventID: uuid.NewString(), Kind: "execution_state", StateSequence: sequence, CollectionState: stateName, Capability: state.Capability, ReasonCodes: reasons, ObservedAt: time.Now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano), Seal: seal}
}
func TestUsageBatchAcknowledgesCommittedStateAndPreservesStickyDiagnostics(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	first, second := stateEvent(reg.State, "1", "collecting", false), stateEvent(reg.State, "2", "partial", true)
	result, err := f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(first, second))
	if err != nil || len(result.Results) != 2 || result.Results[0].Outcome != "stale" || result.Results[1].Outcome != "replaced" || core.Value(result.Results[0].StateSequence) != "2" || result.Results[0].BodyHash != result.Results[1].BodyHash {
		t.Fatal(result, err)
	}
	observed, err := f.service.State(ctx, f.actor, reg.State.ID)
	if err != nil || observed.BodyHash != result.Results[0].BodyHash || observed.SealedAt == nil {
		t.Fatal(observed, err)
	}
	replayed, err := f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(first, second))
	if err != nil || replayed.Results[0].Outcome != "stale" || replayed.Results[1].Outcome != "duplicate" || replayed.Results[1].RowVersion != observed.RowVersion {
		t.Fatal(replayed, err)
	}
	regression := stateEvent(reg.State, "3", "collecting", false)
	unrelated := measurement(reg.State.ID, "7")
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(unrelated, regression))
	requireCode(t, err, "finality_regression")
	var diagnostic *model.UsageFault
	if !errors.As(err, &diagnostic) || !diagnostic.DiagnosticCommitted {
		t.Fatal(err)
	}
	sources, err := f.service.Sources(ctx, reg.State.ID, reg.Grant.Token, []string{unrelated.SourceKey})
	if err != nil || len(sources.Items) != 0 || len(sources.MissingKeys) != 1 {
		t.Fatal(sources, err)
	}
	removeSticky := stateEvent(reg.State, "4", "partial", true)
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(removeSticky))
	requireCode(t, err, "source_conflict")
	if !errors.As(err, &diagnostic) || !diagnostic.DiagnosticCommitted {
		t.Fatal(err)
	}
	removeSticky.ReasonCodes = core.MergeReasons(removeSticky.ReasonCodes, "source_conflict")
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(removeSticky)); err != nil {
		t.Fatal(err)
	}
}
func TestUsageStateAndRecordsExposeDerivedAttributionGap(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	reg, err := f.service.Register(ctx, f.actor, f.registration)
	if err != nil {
		t.Fatal(err)
	}
	unattributed := measurement(reg.State.ID, "7")
	unattributed.AggregationRole = "unattributed"
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(unattributed, stateEvent(reg.State, "1", "partial", true))); err != nil {
		t.Fatal(err)
	}
	observed, err := f.service.State(ctx, f.actor, reg.State.ID)
	if err != nil {
		t.Fatal(err)
	}
	page, err := f.service.Records(ctx, f.actor, f.project, f.task, "", app.PageRequest{Kind: "execution_state", Limit: 100})
	if err != nil || len(page.Items) != 1 {
		t.Fatal(page, err)
	}
	summary, err := f.service.TaskSummaries(ctx, f.actor, f.project, []string{f.task})
	if err != nil {
		t.Fatal(err)
	}
	for _, reasons := range [][]string{observed.ReasonCodes, page.Items[0].ReasonCodes, summary.Items[0].Summary.ReasonCodes} {
		found := false
		for _, reason := range reasons {
			found = found || reason == "attribution_unknown"
		}
		if !found {
			t.Fatal("derived gap missing", reasons)
		}
	}
	if summary.Items[0].Summary.MeasurementRecords != "0" || summary.Items[0].Summary.Metrics["outputTokens"].Known != nil {
		t.Fatal("unattributed amount was counted", summary)
	}
}
func TestUsageStandaloneIsolationCreatorAndDeletion(t *testing.T) {
	f := workflow(t)
	ctx := t.Context()
	registration := f.registration
	registration.SessionID = uuid.NewString()
	registration.NativeSessionID = "standalone-native"
	execution := uuid.NewString()
	snapshot := sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: registration.SessionID, TestExecutionID: execution, ExecutionGeneration: "1"}, ConnectionEpoch: "1"}, Identity: sp.Identity{Provider: "copilot", ControllerInstanceID: registration.ControllerInstanceID, NativeSessionID: &registration.NativeSessionID}, Lifecycle: "active"}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	testutil.MustExec(t, f.db.Pool, `INSERT INTO task_sessions(id,scope,test_execution_id,owner_user_id,registration_id,registration,snapshot,parent_credential_id,connection_parent_credential_id) VALUES($1,'test',$2,$3,$4,'{}',$5,$6,$6)`, registration.SessionID, execution, f.actor.UserID, uuid.NewString(), raw, f.actor.CredentialID)
	testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{testExecutionId}',to_jsonb($2::text)) WHERE id=$1`, registration.SessionID, uuid.NewString())
	_, err = f.service.Register(ctx, f.actor, registration)
	requireCode(t, err, "registration_unavailable")
	testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET snapshot=$2 WHERE id=$1`, registration.SessionID, raw)
	reg, err := f.service.Register(ctx, f.actor, registration)
	if err != nil || reg.State.ProjectID != nil || reg.State.TaskID != nil || core.Value(reg.State.TestExecutionID) != execution {
		t.Fatal(reg, err)
	}
	if _, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "7"))); err != nil {
		t.Fatal(err)
	}
	summary, err := f.service.TestSummary(ctx, f.actor, registration.SessionID)
	if err != nil || core.Value(summary.Metrics["outputTokens"].Known) != "7" {
		t.Fatal(summary, err)
	}
	page, err := f.service.Records(ctx, f.actor, "", "", registration.SessionID, app.PageRequest{Kind: "measurement", Limit: 100})
	if err != nil || len(page.Items) != 1 {
		t.Fatal(page, err)
	}
	taskSummary, err := f.service.TaskSummaries(ctx, f.actor, f.project, []string{f.task})
	if err != nil || taskSummary.Items[0].Summary.MeasurementRecords != "0" {
		t.Fatal(taskSummary, err)
	}
	_, outsider, _ := testutil.AuthRecords(t, f.db)
	_, err = f.service.TestSummary(ctx, outsider, registration.SessionID)
	requireCode(t, err, "resource_unavailable")
	_, err = f.service.Revoke(ctx, outsider, reg.State.ID, reg.State.RowVersion)
	requireCode(t, err, "resource_unavailable")
	_, err = f.service.Revoke(ctx, f.actor, reg.State.ID, reg.State.RowVersion)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "1")))
	requireCode(t, err, "permission_revoked")
	if _, err = f.service.TestSummary(ctx, f.actor, registration.SessionID); err != nil {
		t.Fatal("revocation removed history", err)
	}
	testutil.MustExec(t, f.db.Pool, `DELETE FROM task_sessions WHERE id=$1`, registration.SessionID)
	_, err = f.service.TestSummary(ctx, f.actor, registration.SessionID)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatal(err)
	}
}
func finishUsageRotation(t *testing.T, f *workflowFixture, reg app.RegistrationResult) {
	t.Helper()
	ctx := t.Context()
	input := app.GrantRequest{ExpectedRowVersion: "1", SessionID: f.session, Generation: "1", ControllerInstanceID: f.registration.ControllerInstanceID, ConnectionEpoch: "1"}
	rotated, err := f.service.Rotate(ctx, f.actor, reg.State.ID, input)
	if err != nil || rotated.Grant == nil {
		t.Fatal(rotated, err)
	}
	_, err = f.service.Batch(ctx, reg.State.ID, reg.Grant.Token, batch(measurement(reg.State.ID, "1")))
	requireCode(t, err, "invalid_grant")
	_, err = f.service.Rotate(ctx, f.actor, reg.State.ID, input)
	requireCode(t, err, "usage_changed")
	testutil.MustExec(t, f.db.Pool, `UPDATE task_sessions SET snapshot=jsonb_set(snapshot,'{executionGeneration}','"2"') WHERE id=$1`, f.session)
	resume := f.registration
	resume.StateID = uuid.NewString()
	resume.Generation = "2"
	resume.RegistrationID = uuid.NewString()
	next, err := f.service.Register(ctx, f.actor, resume)
	if err != nil || core.Value(next.State.AnchorStateID) != reg.State.ID {
		t.Fatal(next, err)
	}
	oldEvent := measurement(reg.State.ID, "3")
	if _, err = f.service.Batch(ctx, next.State.ID, next.Grant.Token, batch(oldEvent)); err != nil {
		t.Fatal("origin replay", err)
	}
	sources, err := f.service.Sources(ctx, next.State.ID, next.Grant.Token, []string{oldEvent.SourceKey})
	if err != nil || sources.Items[0].OriginatingStateID != reg.State.ID {
		t.Fatal(sources, err)
	}
	testutil.MustExec(t, f.db.Pool, `UPDATE usage_records SET grant_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, reg.State.ID)
	_, err = f.service.Batch(ctx, next.State.ID, next.Grant.Token, batch(measurement(reg.State.ID, "5")))
	requireCode(t, err, "origin_unavailable")
	if _, err = f.service.Revoke(ctx, f.actor, next.State.ID, "1"); err != nil {
		t.Fatal(err)
	}
	_, err = f.service.Batch(ctx, next.State.ID, next.Grant.Token, batch(measurement(next.State.ID, "5")))
	requireCode(t, err, "permission_revoked")
}
