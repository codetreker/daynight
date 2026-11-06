package task

import (
	"encoding/json"
	"testing"
)

func TestUpdateWorkerInputStartupReport(t *testing.T) {
	fields := map[string]json.RawMessage{
		"version":       json.RawMessage(`1`),
		"claimId":       json.RawMessage(`"11111111-1111-4111-8111-111111111111"`),
		"startupReport": json.RawMessage(`{"schemaVersion":1,"source":"worker","sessionId":"22222222-2222-4222-8222-222222222222","claimId":"11111111-1111-4111-8111-111111111111","executionGeneration":"1","controllerInstanceId":"33333333-3333-4333-8333-333333333333","revision":"1","observedAt":"2026-11-05T00:00:00Z","startup":{"state":"unknown","reasonCode":"native_timeout"},"recovery":{"state":"blocked","reasonCode":"native_identity_missing"}}`),
	}
	input, err := updateWorkerInput(fields)
	if err != nil || input.StartupReport == nil || input.StartupReport.ClaimID != "11111111-1111-4111-8111-111111111111" || input.StartupReport.Startup.ReasonCode != "native_timeout" {
		t.Fatalf("valid startup report: %+v %v", input.StartupReport, err)
	}
	fields["startupReport"] = json.RawMessage(`{"schemaVersion":1}`)
	if _, err := updateWorkerInput(fields); err == nil {
		t.Fatal("accepted incomplete startup report")
	}
}
