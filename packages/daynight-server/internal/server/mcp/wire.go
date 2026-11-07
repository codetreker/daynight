package mcp

import (
	"context"
	"strconv"
	"time"

	taskprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/task"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
)

// Decimal encodes an integer without passing it through a JSON number.
func Decimal(value int64) string { return strconv.FormatInt(value, 10) }

// ParseVersion accepts only a canonical positive decimal representable by int64.
func ParseVersion(value string) (int64, error) {
	return parseDecimal(value, false)
}

// ParseBytes accepts only a canonical nonnegative decimal representable by int64.
func ParseBytes(value string) (int64, error) {
	return parseDecimal(value, true)
}

func parseDecimal(value string, allowZero bool) (int64, error) {
	invalid := &core.Fault{Code: "invalid_input", Message: "Expected a canonical decimal integer within range."}
	if len(value) == 0 || (len(value) > 1 && value[0] == '0') {
		return 0, invalid
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return 0, invalid
		}
	}
	v, err := strconv.ParseInt(value, 10, 64)
	if err != nil || (!allowZero && v == 0) {
		return 0, invalid
	}
	return v, nil
}

// ResolveTeamID resolves an explicit UUID or the current user's personal team.
// This does not authorize access to the selected team.
func ResolveTeamID(ctx context.Context, identity *identity.Identity, principal core.Principal, selection string) (string, error) {
	if selection != "personal" {
		return core.CanonicalID(selection)
	}
	id, err := identity.PersonalTeamID(ctx, principal)
	if err != nil {
		return "", err
	}
	return core.CanonicalID(id)
}

type TeamRef struct {
	ID   string  `json:"id"`
	Kind string  `json:"kind"`
	Name *string `json:"name"`
}

func MapTeamRef(t core.TeamRef) TeamRef { return TeamRef{ID: t.ID, Kind: t.Kind, Name: t.Name} }

type ProjectSettings struct {
	Version                 string `json:"version"`
	ExecutionWarningMinutes int32  `json:"executionWarningMinutes"`
}

type ProjectOwnership struct {
	TeamID    string    `json:"teamId"`
	Version   string    `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type Project struct {
	ID        string           `json:"id"`
	Name      string           `json:"name"`
	RepoURL   string           `json:"repoUrl"`
	CreatedAt time.Time        `json:"createdAt"`
	UpdatedAt time.Time        `json:"updatedAt"`
	Settings  ProjectSettings  `json:"settings"`
	Ownership ProjectOwnership `json:"ownership"`
}

func MapProject(p core.Project) Project {
	return Project{ID: p.ID, Name: p.Name, RepoURL: p.RepoURL, CreatedAt: p.CreatedAt.UTC(), UpdatedAt: p.UpdatedAt.UTC(),
		Settings:  ProjectSettings{Version: Decimal(p.Settings.Version), ExecutionWarningMinutes: p.Settings.ExecutionWarningMinutes},
		Ownership: ProjectOwnership{TeamID: p.Ownership.TeamID, Version: Decimal(p.Ownership.Version), UpdatedAt: p.Ownership.UpdatedAt.UTC()}}
}

type TeamMember struct {
	TeamID    string           `json:"teamId"`
	UserID    string           `json:"userId"`
	Role      core.ProjectRole `json:"role"`
	Version   string           `json:"version"`
	CreatedAt time.Time        `json:"createdAt"`
	UpdatedAt time.Time        `json:"updatedAt"`
}

type Team struct {
	TeamRef
	Version    string     `json:"version"`
	CreatedAt  time.Time  `json:"createdAt"`
	UpdatedAt  time.Time  `json:"updatedAt"`
	Membership TeamMember `json:"membership"`
}

func MapTeam(t core.Team) Team {
	m := t.Membership
	return Team{TeamRef: MapTeamRef(t.TeamRef), Version: Decimal(t.Version), CreatedAt: t.CreatedAt.UTC(), UpdatedAt: t.UpdatedAt.UTC(),
		Membership: TeamMember{TeamID: m.TeamID, UserID: m.UserID, Role: m.Role, Version: Decimal(m.Version), CreatedAt: m.CreatedAt.UTC(), UpdatedAt: m.UpdatedAt.UTC()}}
}

type TaskFull = taskprotocol.MCPFull

func utcTime(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	t := value.UTC()
	return &t
}

// MapTaskFull copies each raw property value without rewriting arbitrary JSON numbers.
func MapTaskFull(t core.Task) TaskFull { return taskprotocol.MCPTask(t) }

type TaskSummary = taskprotocol.MCPSummary

const titlePreviewBytes = taskprotocol.MCPTitlePreviewBytes

func MapTaskSummary(t core.Task) TaskSummary {
	return taskprotocol.MCPTaskSummary(t)
}
