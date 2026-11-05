package properties

import (
	"encoding/json"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperty "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
)

func TestSessionStartupIsStrictAndReadOnly(t *testing.T) {
	raw := json.RawMessage(`{"schemaVersion":1,"source":"worker","sessionId":"11111111-1111-4111-8111-111111111111","claimId":"22222222-2222-4222-8222-222222222222","executionGeneration":"1","controllerInstanceId":"33333333-3333-4333-8333-333333333333","revision":"1","observedAt":"2026-11-05T00:00:00Z","startup":{"state":"unknown","reasonCode":"native_timeout"},"recovery":{"state":"blocked","reasonCode":"native_identity_missing"}}`)
	if _, err := taskproperty.NormalizeValue("sessionStartup", raw); err != nil {
		t.Fatalf("valid startup evidence rejected: %v", err)
	}
	if _, err := normalizeValueForTest("sessionStartup", raw, true); err == nil {
		t.Fatal("ordinary property writes can forge startup evidence")
	}
	if _, err := taskproperty.NormalizeValue("sessionStartup", json.RawMessage(`{"schemaVersion":2}`)); err == nil {
		t.Fatal("invalid stored property passed normalization")
	}
	if report, err := taskproperty.SessionStartup(model.TaskProperties{"sessionStartup": raw}); err != nil || report == nil || report.Startup.ReasonCode != "native_timeout" {
		t.Fatalf("stored evidence: %#v %v", report, err)
	}
	if report, err := taskproperty.SessionStartup(model.TaskProperties{}); err != nil || report != nil {
		t.Fatalf("missing evidence must remain absent: %#v %v", report, err)
	}
	if _, err := taskproperty.SessionStartup(model.TaskProperties{"sessionStartup": json.RawMessage(`{"schemaVersion":2}`)}); err == nil {
		t.Fatal("invalid stored evidence became readable")
	}
}

func TestRemovingWorkerClearsStartupWithoutMutatingSource(t *testing.T) {
	worker := workerFixture()
	original, err := WithWorker(model.TaskProperties{"sessionStartup": json.RawMessage(`{"retained":true}`), "paused": json.RawMessage(`true`)}, &worker)
	if err != nil {
		t.Fatal(err)
	}
	result, err := WithWorker(original, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := result["worker"]; ok {
		t.Fatal("worker was not cleared")
	}
	if _, ok := result["sessionStartup"]; ok {
		t.Fatal("startup evidence survived worker removal")
	}
	if _, ok := original["worker"]; !ok || string(original["sessionStartup"]) != `{"retained":true}` || string(result["paused"]) != `true` {
		t.Fatal("worker removal changed the input or unrelated values")
	}
	result["paused"][0] = 'X'
	if string(original["paused"]) != `true` {
		t.Fatal("worker removal shared property bytes")
	}
}
