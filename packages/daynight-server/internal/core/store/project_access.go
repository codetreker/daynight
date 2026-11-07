package store

type ProjectScopeKind string

const (
	ProjectScopeAll    ProjectScopeKind = "all"
	ProjectScopeTeam   ProjectScopeKind = "team"
	ProjectScopeShared ProjectScopeKind = "shared"
)

type ProjectScope struct {
	Kind   ProjectScopeKind
	TeamID string
	// MaxItemBytes bounds materialized text per item; zero leaves it unrestricted.
	MaxItemBytes int
}
