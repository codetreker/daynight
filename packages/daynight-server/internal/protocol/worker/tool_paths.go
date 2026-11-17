package worker

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

type ToolPathChoice = model.ToolPathChoice
type WorkerToolPaths = model.WorkerToolPaths
type ToolPathTelemetry = model.ToolPathTelemetry
type ToolPathObservation = model.ToolPathObservation
type ToolPathActual = model.ToolPathActual
type ToolPathActiveSelection = model.ToolPathActiveSelection
type ToolPathError = model.ToolPathError

// CurrentDetail omits retired tool observations while preserving known Web facts.
func CurrentDetail(snapshot model.WorkerSnapshot) WorkerDetail {
	if snapshot.Telemetry.ToolPaths != nil {
		copy := *snapshot.Telemetry.ToolPaths
		copy.Entries = make([]model.ToolPathObservation, 0, len(copy.Entries))
		for _, entry := range snapshot.Telemetry.ToolPaths.Entries {
			if (entry.Tool == "codex" || entry.Tool == "copilot") && entry.Context == "web" {
				copy.Entries = append(copy.Entries, entry)
			}
		}
		snapshot.Telemetry.ToolPaths = &copy
	}
	return Detail(snapshot)
}
