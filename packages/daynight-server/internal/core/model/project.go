package model

import "time"

type ProjectSettings struct {
	Version                 int64
	ExecutionWarningMinutes int32
}

type ProjectOwnership struct {
	TeamID    string
	Version   int64
	UpdatedAt time.Time
}

type Project struct {
	ID        string
	Name      string
	RepoURL   string
	CreatedAt time.Time
	UpdatedAt time.Time
	Settings  ProjectSettings
	Ownership ProjectOwnership
}
