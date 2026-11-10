package server

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

var capacityObservedAt = time.Date(2026, 11, 8, 0, 0, 0, 0, time.UTC)

func capacityDecode[T any](t *testing.T, value any) T {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var got T
	if err := json.Unmarshal(encoded, &got); err != nil {
		t.Fatal(err)
	}
	return got
}

func capacityExpectedSnapshot(t *testing.T, user, worker string, body map[string]any) model.WorkerSnapshot {
	t.Helper()
	telemetry := capacityDecode[model.WorkerTelemetry](t, body)
	observation := model.WorkerTaskObservation{State: model.WorkerTasksUnavailable, Items: []model.WorkerObservedTask{}}
	if body["taskInventory"] != nil {
		inventory := capacityDecode[model.WorkerTaskInventory](t, body["taskInventory"])
		observation = model.WorkerTaskObservation{State: model.WorkerTasksObserved, ObservedAt: &capacityObservedAt, InventoryObservedAt: &inventory.ObservedAt, Items: []model.WorkerObservedTask{}}
	}
	return model.WorkerSnapshot{UserID: user, WorkerID: worker, CreatedAt: capacityObservedAt, LastReportedAt: capacityObservedAt, Telemetry: telemetry, TaskSnapshot: observation}
}
