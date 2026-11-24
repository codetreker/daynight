//go:build integration

package main

import (
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func serverAPIWorkerLifecycleFlow(t *testing.T, f *fixture) {
	workerID, instanceID := uuid.NewString(), uuid.NewString()
	base := "/api/v1/me/workers/" + workerID
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	probe := func(value any) any { return map[string]any{"state": "ok", "checkedAt": stamp, "value": value} }
	report := map[string]any{
		"machine": map[string]any{"id": uuid.NewString(), "name": "Lifecycle integration"}, "platform": "linux", "workingDirectory": "/work", "sampledAt": stamp,
		"os":     probe(map[string]any{"type": "Linux", "release": "6.8", "version": "kernel", "arch": "x64"}),
		"cpu":    probe(map[string]any{"model": "CPU", "logicalProcessors": 4, "usagePercent": 1}),
		"memory": probe(map[string]any{"usedBytes": 4, "totalBytes": 8}), "disk": probe(map[string]any{"availableBytes": 8, "totalBytes": 16}),
		"versions": map[string]any{"daynight": "1.0.0", "codex": probe("1.0.0"), "copilot": probe("1.0.0")}, "taskInventory": nil,
		"toolPaths": map[string]any{"schemaVersion": 1, "observedAt": stamp, "entries": []any{}},
	}
	reportHeaders := http.Header{"Daynight-Worker-Tool-Paths": {"2"}}
	requestJSON[map[string]any](t, f, http.MethodPost, base+"/report", report, http.StatusOK, reportHeaders)
	base += "/lifecycle"
	headers := http.Header{"X-Daynight-Worker-Lifecycle": {"1"}}
	registered := requestJSON[model.LifecycleInstanceReceipt](t, f, http.MethodPost, base+"/instances", model.LifecycleInstanceRequest{ProtocolVersion: 1, OperationID: uuid.NewString(), InstanceID: instanceID, Capabilities: model.LifecycleCapabilities{Disable: true, Resume: true, Inventory: 1, DispatchFence: 1}, Platform: "linux"}, http.StatusOK, headers)
	if registered.InstanceID != instanceID || registered.IntentVersion != "1" || registered.Admission != "closed" {
		t.Fatalf("registered: %+v", registered)
	}
	disableID := uuid.NewString()
	disabled := requestJSON[model.LifecycleIntentReceipt](t, f, http.MethodPost, base+"/operations", model.LifecycleIntentRequest{ProtocolVersion: 1, OperationID: disableID, Action: "disable", ExpectedVersion: "1", Source: "web"}, http.StatusAccepted, headers)
	if disabled.IntentVersion != "2" || disabled.Desired != "disabled" || disabled.Admission != "closed" {
		t.Fatalf("disable receipt: %+v", disabled)
	}
	zero := int64(0)
	observation := model.LifecycleObservationEnvelope{ProtocolVersion: 1, InstanceID: instanceID, IntentVersion: "2", OperationID: &disableID, LocalEpoch: "2", ScopeGeneration: "1", ReportSequence: "1", Observation: model.LifecycleObservation{Phase: "disabled", Stop: "confirmed", Save: "durable", Sync: "complete", InventoryComplete: true, DetailsComplete: true, InventoryRevision: "1", InventoryDigest: strings.Repeat("0", 64), ResourceCount: &zero, StoppedCount: &zero, PendingCount: &zero, BlockedCount: &zero, Resources: []model.LifecycleResourceObservation{}, Recovery: []model.LifecycleRecoveryObservation{}}}
	requestJSON[model.LifecycleObservationReceipt](t, f, http.MethodPost, base+"/observations", observation, http.StatusOK, headers)
	state := requestJSON[model.LifecycleResource](t, f, http.MethodGet, base, nil, http.StatusOK, headers)
	if state.Observation == nil || state.Observation.Observation.Phase != "disabled" || state.Observation.Observation.ReceivedAt.IsZero() || !state.Observation.Observation.FreshUntil.After(state.Observation.Observation.ReceivedAt) {
		t.Fatalf("stopped facts: %+v", state)
	}
	f.restart(func() {})
	persisted := requestJSON[model.LifecycleResource](t, f, http.MethodGet, base, nil, http.StatusOK, headers)
	if persisted.Desired != "disabled" || persisted.Admission != "closed" || persisted.IntentVersion != "2" || persisted.OperationID == nil || *persisted.OperationID != disableID {
		t.Fatalf("Server restart changed stop intent: %+v", persisted)
	}
	originalDisable := requestJSON[model.LifecycleOperationResult](t, f, http.MethodGet, base+"/operations/"+disableID, nil, http.StatusOK, headers)
	if originalDisable.Kind != "intent" || originalDisable.Receipt == nil {
		t.Fatalf("Server restart lost original operation: %+v", originalDisable)
	}
	observation.ReportSequence = "2"
	requestJSON[model.LifecycleObservationReceipt](t, f, http.MethodPost, base+"/observations", observation, http.StatusOK, headers)
	resumeID, localEpoch := uuid.NewString(), "2"
	resumed := requestJSON[model.LifecycleIntentReceipt](t, f, http.MethodPost, base+"/operations", model.LifecycleIntentRequest{ProtocolVersion: 1, OperationID: resumeID, Action: "resume", ExpectedVersion: "2", Source: "web", LocalEpoch: &localEpoch, InstanceID: &instanceID}, http.StatusAccepted, headers)
	if resumed.IntentVersion != "3" || resumed.Admission != "closed" {
		t.Fatalf("resume prematurely opened: %+v", resumed)
	}
	observation.IntentVersion = "3"
	observation.OperationID = &resumeID
	observation.ScopeGeneration = "2"
	observation.ReportSequence = "3"
	observation.Observation.Phase = "resuming"
	requestJSON[model.LifecycleObservationReceipt](t, f, http.MethodPost, base+"/observations", observation, http.StatusOK, headers)
	active := requestJSON[model.LifecycleActivationReceipt](t, f, http.MethodPost, base+"/activations", model.LifecycleActivationRequest{ProtocolVersion: 1, OperationID: resumeID, InstanceID: instanceID, IntentVersion: "3", LocalEpoch: "2", ScopeGeneration: "2", ReportSequence: "3"}, http.StatusOK, headers)
	if active.Admission != "open" || active.Action != "resume" || active.IntentVersion != "3" {
		t.Fatalf("activation: %+v", active)
	}
	original := requestJSON[model.LifecycleOperationResult](t, f, http.MethodGet, base+"/operations/"+resumeID, nil, http.StatusOK, headers)
	if original.Kind != "intent" || original.ActivationOutcome != "committed" || original.Activation == nil {
		t.Fatalf("original result: %+v", original)
	}
	state = requestJSON[model.LifecycleResource](t, f, http.MethodGet, base, nil, http.StatusOK, headers)
	if state.Desired != "enabled" || state.Admission != "open" {
		t.Fatalf("current authority: %+v", state)
	}
}
