package model

import "time"

// TaskHeader permits child resources to check identity, deletion and version
// without hydrating unrelated task properties, dependencies or execution state.
type TaskHeader struct {
	ProjectID string
	ID        string
	Type      TaskType
	Version   int64
	DeletedAt *time.Time
}
