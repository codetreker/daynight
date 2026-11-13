package model

import "time"

// TagReference is a stable tag identity and its current display name.
type TagReference struct {
	ID   string
	Name string
}

// Tag is a project-owned catalog entry. NameKey is the stored comparison key.
type Tag struct {
	ID        string
	ProjectID string
	Name      string
	NameKey   string
	Version   int64
	CreatedAt time.Time
	UpdatedAt time.Time
}

// TagUsage counts visible resources, including terminal resources.
type TagUsage struct {
	Tasks int64
	Goals int64
}
