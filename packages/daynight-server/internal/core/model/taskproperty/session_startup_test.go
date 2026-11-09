package taskproperty_test

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/properties"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func TestSessionStartupWriteAdmissionAndStoredValue(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":1,"source":"worker","sessionId":"11111111-1111-4111-8111-111111111111","claimId":"22222222-2222-4222-8222-222222222222","executionGeneration":"1","controllerInstanceId":"33333333-3333-4333-8333-333333333333","revision":"1","observedAt":"2026-11-05T00:00:00Z","startup":{"state":"unknown","reasonCode":"native_timeout"},"recovery":{"state":"blocked","reasonCode":"native_identity_missing"}}`)
	if _, err := taskproperty.NormalizeValue("sessionStartup", raw); err != nil {
		t.Fatalf("valid startup evidence rejected: %v", err)
	}
	if _, err := properties.Normalize(model.TaskProperties{"sessionStartup": raw}); err == nil {
		t.Fatal("ordinary property writes can forge startup evidence")
	}
	if _, err := taskproperty.NormalizeValue("sessionStartup", json.RawMessage(`{"schemaVersion":2}`)); err == nil {
		t.Fatal("invalid startup evidence passed normalization")
	}
	if report, err := taskproperty.SessionStartup(model.TaskProperties{"sessionStartup": raw}); err != nil || report == nil || report.Startup.ReasonCode != "native_timeout" {
		t.Fatalf("stored evidence: %#v %v", report, err)
	}
	if report, err := taskproperty.SessionStartup(model.TaskProperties{}); err != nil || report != nil {
		t.Fatalf("missing evidence must remain absent: %#v %v", report, err)
	}
	if _, err := taskproperty.SessionStartup(model.TaskProperties{"sessionStartup": json.RawMessage(`{"schemaVersion":"invalid"}`)}); err == nil {
		t.Fatal("startup evidence decoding error was hidden")
	}
}
