package store

import (
	"context"
	"time"
)

// PersonalTaskProject describes all mutable facts used to fence an active project.
// Counts and sums use decimal strings so aggregation never overflows int64.
type PersonalTaskProject struct {
	ID                      string  `json:"id"`
	Name                    string  `json:"name"`
	OwnerTeamID             string  `json:"ownerTeamId"`
	OwnerTeamKind           string  `json:"ownerTeamKind"`
	OwnerTeamName           *string `json:"ownerTeamName"`
	OwnershipVersion        int64   `json:"ownershipVersion"`
	SettingsVersion         int64   `json:"settingsVersion"`
	ExecutionWarningMinutes int     `json:"executionWarningMinutes"`
	MatchedCount            string  `json:"matchedCount"`
	TaskCacheEpoch          string  `json:"taskCacheEpoch"`
	AllTaskCount            string  `json:"allTaskCount"`
	AllTaskVersionSum       string  `json:"allTaskVersionSum"`
}

// PersonalTaskPosition is the complete, deterministic ordering key of a row.
type PersonalTaskPosition struct {
	ProjectName   string     `json:"projectName"`
	OwnerTeamKind string     `json:"ownerTeamKind"`
	OwnerTeamName *string    `json:"ownerTeamName"`
	OwnerTeamID   string     `json:"ownerTeamId"`
	ProjectID     string     `json:"projectId"`
	StartedAt     *time.Time `json:"startedAt"`
	TaskID        string     `json:"taskId"`
}

type PersonalTaskRow struct {
	ProjectID, ID, Title string
	Version              int64
	StartedAt            *time.Time
	AllowAgents          bool
	GoalID, GoalTitle    *string
	PausedRaw            *string
	Position             PersonalTaskPosition
}
type PersonalTaskQuery struct {
	Limit int
	After *PersonalTaskPosition
}
type PersonalTaskPage struct {
	Items   []PersonalTaskRow
	HasMore bool
}

// PersonalTaskReader is used inside the same read-only snapshot as credential
// validation and source selection. The actor is always the authenticated user.
type PersonalTaskReader interface {
	PersonalTaskFacts(context.Context, string) ([]PersonalTaskProject, error)
	PersonalTaskPage(context.Context, string, PersonalTaskQuery) (PersonalTaskPage, error)
}
