package store

import (
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// WorkerSummary is the bounded list projection, including the original cursor position.
type WorkerSummary struct {
	WorkerID             string
	CreatedAt            time.Time
	LastReportedAt       time.Time
	Machine              model.WorkerMachine
	Platform             model.TaskPlatform
	TaskObservationState model.WorkerTaskObservationState
	TaskObservedAt       *time.Time
	ActiveTaskCount      *int
	Oversized            bool
}
