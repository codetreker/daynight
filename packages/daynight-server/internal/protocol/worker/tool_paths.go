package worker

import "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"

// Capabilities select independent optional fields without changing prompt versions.
type Capabilities struct {
	ControlMode bool
	ToolPaths   bool
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
	}
	return Detail(snapshot)
}
