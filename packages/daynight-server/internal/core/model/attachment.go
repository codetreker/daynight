package model

import "time"

type Attachment struct {
	ProjectID   string
	TaskID      string
	Path        string
	ContentType string
	SizeBytes   int64
	CreatedAt   time.Time
	UpdatedAt   time.Time
}
