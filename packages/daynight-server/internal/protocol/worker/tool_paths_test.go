package worker

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestCurrentDetailProjectsOnlySupportedToolObservations(t *testing.T) {
	telemetry := &model.ToolPathTelemetry{Entries: []model.ToolPathObservation{
		{Tool: "codex", Context: "web"},
		{Tool: "old-tool", Context: "old-context"},
		{Tool: "copilot", Context: "old-context"},
	}}
	detail := CurrentDetail(model.WorkerSnapshot{Telemetry: model.WorkerTelemetry{ToolPaths: telemetry}})
	if detail.Telemetry.ToolPaths == nil || len(detail.Telemetry.ToolPaths.Entries) != 1 || detail.Telemetry.ToolPaths.Entries[0].Tool != "codex" {
		t.Fatalf("current tool observation projection: %+v", detail.Telemetry.ToolPaths)
	}
	if len(telemetry.Entries) != 3 {
		t.Fatal("projection changed the stored observation")
	}
}
