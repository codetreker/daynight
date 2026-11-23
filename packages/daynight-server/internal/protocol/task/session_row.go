package task

import (
	"strconv"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type SessionRow struct {
	TaskVersion    string     `json:"taskVersion"`
	State          string     `json:"state"`
	ObservedAt     *time.Time `json:"observedAt"`
	FreshUntil     *time.Time `json:"freshUntil"`
	NeedsAttention *bool      `json:"needsAttention"`
	CanOpen        bool       `json:"canOpen"`
}

func SessionRowResponse(observation model.TaskSyncObservation) SessionRow {
	return SessionRow{TaskVersion: strconv.FormatInt(observation.TaskVersion, 10), State: observation.State, ObservedAt: observation.ObservedAt, FreshUntil: observation.FreshUntil, NeedsAttention: observation.NeedsAttention, CanOpen: observation.CanOpen}
}
