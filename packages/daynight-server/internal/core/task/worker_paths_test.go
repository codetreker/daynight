package task

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"
)

func validDescriptor() WorkerDescriptor {
	return WorkerDescriptor{ClaimID: "00000000-0000-4000-8000-000000000001", WorkerID: "00000000-0000-4000-8000-000000000002", Machine: model.WorkerMachine{ID: "00000000-0000-4000-8000-000000000003", Name: "machine"}, Platform: model.PlatformLinux, Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeHerdr, WorktreeID: "00000000-0000-4000-8000-000000000004"}
}
func activeFixture(t *testing.T) (model.Task, *model.WorkerClaim) {
	t.Helper()
	d := validDescriptor()
	w := &model.WorkerClaim{ClaimID: d.ClaimID, WorkerID: d.WorkerID, UserID: "00000000-0000-4000-8000-000000000005", Machine: d.Machine, Platform: d.Platform, Agent: d.Agent, AgentControlMode: d.AgentControlMode, WorktreeID: d.WorktreeID, State: model.WorkerActive, Phase: model.WorkerPreparing, ClaimedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	p, err := properties.WithWorker(model.TaskProperties{}, w)
	if err != nil {
		t.Fatal(err)
	}
	return model.Task{ID: "00000000-0000-4000-8000-000000000006", Title: "Task", Status: model.TaskInProgress, Properties: p}, w
}
func TestWorkerClaimLifecycle(t *testing.T) {
	d := validDescriptor()
	d.AgentControlMode = ""
	normal, err := CanonicalWorkerDescriptor(d)
	if err != nil || normal.AgentControlMode != model.AgentControlModeHerdr {
		t.Fatal(normal, err)
	}
	bad := d
	bad.WorkerID = "bad"
	if _, err = CanonicalWorkerDescriptor(bad); err == nil {
		t.Fatal("bad id")
	}
	bad = d
	bad.Platform = "bad"
	if _, err = CanonicalWorkerDescriptor(bad); err == nil {
		t.Fatal("bad platform")
	}
	current, worker := activeFixture(t)
	if _, err = ActiveWorker(current, worker.ClaimID); err != nil {
		t.Fatal(err)
	}
	_, err = ActiveWorker(current, "other")
	faultCode(t, err, "claim_conflict")
	if _, err = WithdrawableWorker(current, worker.ClaimID); err != nil {
		t.Fatal(err)
	}
	_, err = WithdrawableWorker(current, "other")
	faultCode(t, err, "claim_conflict")
	if err = ValidateDelete(t.Context(), &mutationDAO{}, current, true); err == nil {
		t.Fatal("deleted active claim")
	}
	values, err := ReleaseCandidate(current, worker)
	if err != nil || values.Status != model.TaskTodo {
		t.Fatal(values, err)
	}
	released := current
	released.Status = model.TaskTodo
	released.Properties = values.Properties
	if _, err = ReleasedWorker(released, worker.ClaimID); err != nil {
		t.Fatal(err)
	}
	_, err = ReleasedWorker(released, "other")
	faultCode(t, err, "claim_conflict")
	withdrawn, err := WithdrawCandidate(released)
	if err != nil || withdrawn.AllowAgents || withdrawn.Status != model.TaskTodo {
		t.Fatal(withdrawn, err)
	}
	if w, _ := taskproperty.Worker(withdrawn.Properties); w != nil {
		t.Fatal("worker retained")
	}
	fresh, err := AcquireWorker(model.Task{Properties: model.TaskProperties{}}, worker.UserID, normal, time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC))
	if err != nil || fresh.Status != model.TaskInProgress {
		t.Fatal(fresh, err)
	}
}
func TestWorkerUpdatesValidateAndProtectOwner(t *testing.T) {
	current, worker := activeFixture(t)
	claim := worker.ClaimID
	invalidPhase := model.WorkerPhase("bad")
	herdr := &model.WorkerHerdr{}
	native := " "
	badReport := &sp.StartupReport{}
	for _, in := range []UpdateWorker{{ClaimID: "bad"}, {ClaimID: claim}, {ClaimID: claim, Phase: &invalidPhase}, {ClaimID: claim, Herdr: &herdr}, {ClaimID: claim, NativeSessionID: ptr(&native)}, {ClaimID: claim, StartupReport: badReport}} {
		if _, err := ValidateWorkerUpdate(in); err == nil {
			t.Fatalf("accepted %+v", in)
		}
	}
	phase := model.WorkerExecuting
	in := UpdateWorker{ClaimID: claim, Phase: &phase}
	if _, err := ValidateWorkerUpdate(in); err != nil {
		t.Fatal(err)
	}
	values, changed, err := WorkerUpdateCandidate(current, worker, claim, in)
	if err != nil || !changed {
		t.Fatal(values, changed, err)
	}
	next, err := taskproperty.Worker(values.Properties)
	if err != nil || next.Phase != phase {
		t.Fatal(next, err)
	}
	web := *worker
	web.AgentControlMode = model.AgentControlModeWeb
	herdr = &model.WorkerHerdr{Session: "s", WorkspaceID: "w", PaneID: "p"}
	if err := WorkerUpdateAdmission(&web, web.UserID, claim, UpdateWorker{Herdr: &herdr}); err == nil {
		t.Fatal("web herdr")
	}
	faultCode(t, WorkerUpdateAdmission(&web, web.UserID, claim, UpdateWorker{StartupReport: &sp.StartupReport{ClaimID: "other"}}), "claim_conflict")
	if err := WorkerUpdateAdmission(&web, web.UserID, claim, UpdateWorker{}); err != nil {
		t.Fatal(err)
	}
	current.Properties["worker"] = json.RawMessage(`{"bad":true}`)
	if _, err := ActiveWorker(current, claim); err == nil {
		t.Fatal("invalid worker")
	}
}
func TestStatusClaimOwnershipAndTransitions(t *testing.T) {
	current, worker := activeFixture(t)
	dao := &mutationDAO{}
	owner := model.Principal{UserID: worker.UserID}
	_, _, err := StatusCandidate(t.Context(), dao, owner, current, SetTaskStatus{Status: model.TaskTodo}, worker)
	faultCode(t, err, "invalid_transition")
	_, _, err = StatusCandidate(t.Context(), dao, owner, current, SetTaskStatus{Status: model.TaskDone}, worker)
	faultCode(t, err, "claim_conflict")
	_, _, err = StatusCandidate(t.Context(), dao, model.Principal{UserID: "other"}, current, SetTaskStatus{Status: model.TaskDone, ClaimID: &worker.ClaimID}, worker)
	faultCode(t, err, "forbidden")
	values, changed, err := StatusCandidate(t.Context(), dao, owner, current, SetTaskStatus{Status: model.TaskDone, ClaimID: &worker.ClaimID}, worker)
	if err != nil || !changed || values.Status != model.TaskDone {
		t.Fatal(values, changed, err)
	}
	released := *worker
	released.State = model.WorkerReleased
	_, _, err = StatusCandidate(t.Context(), dao, owner, current, SetTaskStatus{Status: model.TaskTodo}, &released)
	faultCode(t, err, "invalid_transition")
	current.BlockedBy = []string{"pre"}
	_, _, err = StatusCandidate(t.Context(), dao, owner, current, SetTaskStatus{Status: model.TaskDone}, nil)
	faultCode(t, err, "dependency_unsatisfied")
}

func TestCancelledReleasedHistoryCannotRestoreExecution(t *testing.T) {
	current, worker := activeFixture(t)
	owner := model.Principal{UserID: worker.UserID}
	_, _, err := StatusCandidate(t.Context(), nil, owner, current, SetTaskStatus{Status: model.TaskCancelled}, worker)
	faultCode(t, err, "invalid_transition")
	released := *worker
	released.State = model.WorkerReleased
	current.Status = model.TaskTodo
	current.Properties, err = properties.WithWorker(current.Properties, &released)
	if err != nil {
		t.Fatal(err)
	}
	values, changed, err := StatusCandidate(t.Context(), nil, owner, current, SetTaskStatus{Status: model.TaskCancelled}, &released)
	if err != nil || !changed || values.Status != model.TaskCancelled {
		t.Fatal(values, changed, err)
	}
	current.Status, current.Properties = values.Status, values.Properties
	retained, err := taskproperty.Worker(current.Properties)
	if err != nil || retained.State != model.WorkerReleased || retained.ClaimID != released.ClaimID {
		t.Fatal(retained, err)
	}
	_, err = WithdrawableWorker(current, released.ClaimID)
	faultCode(t, err, "invalid_transition")
	_, err = WithdrawCandidate(current)
	faultCode(t, err, "invalid_transition")
	_, err = ReleasedWorker(current, released.ClaimID)
	faultCode(t, err, "invalid_transition")
	faultCode(t, WorkerReady(current), "invalid_transition")
}

func TestWorkerFailurePathsAndChangedFields(t *testing.T) {
	current, worker := activeFixture(t)
	if err := WorkerReady(current); err == nil {
		t.Fatal("active task accepted")
	}
	current.Status = model.TaskTodo
	if err := WorkerReady(current); err == nil {
		t.Fatal("active worker accepted")
	}
	current.Properties["worker"] = json.RawMessage(`{"bad":true}`)
	if err := WorkerReady(current); err == nil {
		t.Fatal("invalid worker accepted")
	}
	if _, err := ReleasedWorker(current, worker.ClaimID); err == nil {
		t.Fatal("invalid worker accepted")
	}
	if _, err := WithdrawableWorker(current, worker.ClaimID); err == nil {
		t.Fatal("invalid worker accepted")
	}
	current, worker = activeFixture(t)
	input := UpdateWorker{Herdr: ptr(&model.WorkerHerdr{Session: "session", WorkspaceID: "workspace", PaneID: "pane"}), NativeSessionID: ptr(ptr("native"))}
	values, changed, err := WorkerUpdateCandidate(current, worker, worker.ClaimID, input)
	if err != nil || !changed {
		t.Fatal(values, changed, err)
	}
	report := &sp.StartupReport{SchemaVersion: 1, Source: "worker", SessionID: "11111111-1111-4111-8111-111111111111", ClaimID: worker.ClaimID, ExecutionGeneration: "1", ControllerInstanceID: "33333333-3333-4333-8333-333333333333", Revision: "1", ObservedAt: "2026-11-05T00:00:00Z"}
	report.Startup.State, report.Startup.ReasonCode = "unknown", "native_timeout"
	report.Recovery.State, report.Recovery.ReasonCode = "blocked", ptr("native_identity_missing")
	if _, err := ValidateWorkerUpdate(UpdateWorker{ClaimID: worker.ClaimID, StartupReport: report}); err != nil {
		t.Fatal(err)
	}
	values, changed, err = WorkerUpdateCandidate(current, worker, worker.ClaimID, UpdateWorker{StartupReport: report})
	if err != nil || !changed || len(values.Properties["sessionStartup"]) == 0 {
		t.Fatal(values, changed, err)
	}
}
