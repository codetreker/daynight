package taskproperties

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestSessionStartupIsStrictAndReadOnly(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":1,"source":"worker","sessionId":"11111111-1111-4111-8111-111111111111","claimId":"22222222-2222-4222-8222-222222222222","executionGeneration":"1","controllerInstanceId":"33333333-3333-4333-8333-333333333333","revision":"1","observedAt":"2026-11-05T00:00:00Z","startup":{"state":"unknown","reasonCode":"native_timeout"},"recovery":{"state":"blocked","reasonCode":"native_identity_missing"}}`)
	if _, err := NormalizeValue("sessionStartup", raw, false); err != nil {
		t.Fatalf("valid startup evidence rejected: %v", err)
	}
	if _, err := NormalizeValue("sessionStartup", raw, true); err == nil {
		t.Fatal("ordinary property writes can forge startup evidence")
	}
	if _, err := NormalizeValue("sessionStartup", json.RawMessage(`{"schemaVersion":2}`), false); err == nil {
		t.Fatal("invalid stored property passed normalization")
	}
	if report, err := SessionStartup(model.TaskProperties{"sessionStartup": raw}); err != nil || report == nil || report.Startup.ReasonCode != "native_timeout" {
		t.Fatalf("stored evidence: %#v %v", report, err)
	}
	if report, err := SessionStartup(model.TaskProperties{}); err != nil || report != nil {
		t.Fatalf("missing evidence must remain absent: %#v %v", report, err)
	}
	if _, err := SessionStartup(model.TaskProperties{"sessionStartup": json.RawMessage(`{"schemaVersion":2}`)}); err == nil {
		t.Fatal("invalid stored evidence became readable")
	}
}
