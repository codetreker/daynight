package worker

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

// Capabilities select independent optional fields without changing prompt versions.
type Capabilities struct {
	ToolPaths        bool
	ArchiveSessions  bool
	PlatformTaskMode bool
}

type ToolPathChoice = model.ToolPathChoice
type WorkerToolPaths = model.WorkerToolPaths
type ToolPathTelemetry = model.ToolPathTelemetry
type ToolPathObservation = model.ToolPathObservation
type ToolPathActual = model.ToolPathActual
type ToolPathActiveSelection = model.ToolPathActiveSelection
type ToolPathError = model.ToolPathError

// DetailForCapabilities projects the negotiated fields before HTTP encoding.
func DetailForCapabilities(snapshot model.WorkerSnapshot, capabilities Capabilities) WorkerDetail {
	if !capabilities.ToolPaths {
		snapshot.Telemetry.ToolPaths = nil
	} else if snapshot.Telemetry.ToolPaths != nil {
		paths := *snapshot.Telemetry.ToolPaths
		paths.Entries = make([]model.ToolPathObservation, 0, len(snapshot.Telemetry.ToolPaths.Entries))
		for _, entry := range snapshot.Telemetry.ToolPaths.Entries {
			if (entry.Tool == "codex" || entry.Tool == "copilot") && entry.Context == "web" {
				paths.Entries = append(paths.Entries, entry)
			}
		}
		snapshot.Telemetry.ToolPaths = &paths
	}
	return Detail(snapshot)
}
