package model

import "time"

// TaskSyncObservation is a current-execution projection, not a Task property.
type TaskSyncObservation struct {
	TaskVersion    int64
	State          string
	ObservedAt     *time.Time
	FreshUntil     *time.Time
	NeedsAttention *bool
	CanOpen        bool
}
