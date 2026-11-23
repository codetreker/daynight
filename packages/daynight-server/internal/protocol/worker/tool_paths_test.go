package worker

import (
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestDetailProjectsOnlySupportedToolObservations(t *testing.T) {
	paths := &model.ToolPathTelemetry{SchemaVersion: 1, Entries: []model.ToolPathObservation{
		{Tool: "codex", Context: "web"},
		{Tool: "copilot", Context: "web"},
		{Tool: "codex", Context: "herdr"},
		{Tool: "herdr", Context: "herdr"},
	}}
	snapshot := model.WorkerSnapshot{Telemetry: model.WorkerTelemetry{ToolPaths: paths}}
	result := DetailForCapabilities(snapshot, Capabilities{ToolPaths: true})
	if result.Telemetry.ToolPaths == nil || len(result.Telemetry.ToolPaths.Entries) != 2 || result.Telemetry.ToolPaths.Entries[0].Tool != "codex" || result.Telemetry.ToolPaths.Entries[1].Tool != "copilot" {
		t.Fatalf("projection retained unsupported observations: %+v", result.Telemetry.ToolPaths)
	}
	if len(snapshot.Telemetry.ToolPaths.Entries) != 4 {
		t.Fatal("projection changed stored observations")
	}
	if DetailForCapabilities(snapshot, Capabilities{}).Telemetry.ToolPaths != nil {
		t.Fatal("unnegotiated observations were exposed")
	}
	snapshot.Telemetry.ToolPaths = nil
	if DetailForCapabilities(snapshot, Capabilities{ToolPaths: true}).Telemetry.ToolPaths != nil {
		t.Fatal("absent observations were invented")
	}
}
