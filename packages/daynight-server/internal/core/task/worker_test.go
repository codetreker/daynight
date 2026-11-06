package task

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestClaimAdmissionAndFreshExecution(t *testing.T) {
	user := "00000000-0000-4000-8000-000000000001"
	current := model.Task{Status: model.TaskTodo, AssignedTo: &user, AllowAgents: true, Properties: model.TaskProperties{}}
	descriptor := WorkerDescriptor{Platform: model.PlatformLinux}
	if err := ClaimAdmission(current, user, descriptor); err != nil {
		t.Fatal(err)
	}
	faultCode(t, ClaimAdmission(current, "other", descriptor), "invalid_transition")
	current.BlockedBy = []string{"prerequisite"}
	faultCode(t, ClaimAdmission(current, user, descriptor), "dependency_unsatisfied")
	worker := &model.WorkerClaim{ClaimID: "claim", WorktreeID: "tree"}
	faultCode(t, FreshWorkerExecution(worker, WorkerDescriptor{ClaimID: "claim", WorktreeID: "other"}), "claim_conflict")
	faultCode(t, FreshWorkerExecution(worker, WorkerDescriptor{ClaimID: "other", WorktreeID: "tree"}), "invalid_transition")
}

func TestWorkerUpdateNoopAndOwnership(t *testing.T) {
	worker := &model.WorkerClaim{UserID: "owner", Phase: model.WorkerPreparing}
	phase := model.WorkerPreparing
	input := UpdateWorker{Phase: &phase}
	faultCode(t, WorkerUpdateAdmission(worker, "other", "claim", input), "forbidden")
	_, changed, err := WorkerUpdateCandidate(model.Task{}, worker, "claim", input)
	if err != nil || changed {
		t.Fatalf("same update: changed=%v err=%v", changed, err)
	}
}

func TestLegacyWorkerProtocol(t *testing.T) {
	worker := &model.WorkerClaim{Agent: model.AgentCodex, AgentControlMode: model.AgentControlModeWeb}
	if err := RequireCompatibleWorker(WithLegacyWorkerProtocol(t.Context()), worker); err == nil {
		t.Fatal("legacy request accepted web execution")
	}
	if err := RequireCompatibleWorker(t.Context(), worker); err != nil {
		t.Fatal(err)
	}
}

func TestWorkerStartupRevisionAndNoop(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":1,"source":"worker","sessionId":"11111111-1111-4111-8111-111111111111","claimId":"22222222-2222-4222-8222-222222222222","executionGeneration":"1","controllerInstanceId":"33333333-3333-4333-8333-333333333333","revision":"2","observedAt":"2026-11-05T00:00:00Z","startup":{"state":"unknown","reasonCode":"native_timeout"},"recovery":{"state":"blocked","reasonCode":"native_identity_missing"}}`)
	report, err := sp.DecodeStartupReport(raw)
	if err != nil {
		t.Fatal(err)
	}
	worker := &model.WorkerClaim{Phase: model.WorkerPreparing}
	current := model.Task{Properties: model.TaskProperties{"sessionStartup": raw}}
	_, changed, err := WorkerUpdateCandidate(current, worker, report.ClaimID, UpdateWorker{StartupReport: &report})
	if err != nil || changed {
		t.Fatalf("same startup report: changed=%v err=%v", changed, err)
	}
	report.Revision = "1"
	_, _, err = WorkerUpdateCandidate(current, worker, report.ClaimID, UpdateWorker{StartupReport: &report})
	faultCode(t, err, "claim_conflict")
	report.Revision = "2"
	report.ObservedAt = "2026-11-05T00:00:01Z"
	_, _, err = WorkerUpdateCandidate(current, worker, report.ClaimID, UpdateWorker{StartupReport: &report})
	faultCode(t, err, "claim_conflict")
}
