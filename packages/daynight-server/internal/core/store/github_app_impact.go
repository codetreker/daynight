package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// GitHubAppImpact describes one snapshot of the affected connection set.
type GitHubAppImpact struct {
	Version, ImpactVersion                         int64
	TotalProjects, VisibleProjects, HiddenProjects int64
	GrantMissing                                   bool
}

type GitHubAppImpactTeam struct {
	Team     model.TeamRef
	Projects int64
}

type GitHubAppImpactProject struct {
	ID, Name, RepoURL string
}

type GitHubAppImpactQuery struct {
	AppID, ActorID string
	GrantID        *string
	AfterID        string
	Limit          int
}

type GitHubAppImpactTeams struct {
	Items   []GitHubAppImpactTeam
	HasMore bool
}

type GitHubAppImpactProjects struct {
	Items   []GitHubAppImpactProject
	HasMore bool
}

// GitHubAppImpactDAO is bound to one consistent snapshot. Summary must be
// called first to authorize the actor and exact live App/grant in that snapshot.
type GitHubAppImpactDAO interface {
	Summary(context.Context, GitHubAppImpactQuery) (GitHubAppImpact, error)
	Teams(context.Context, GitHubAppImpactQuery) (GitHubAppImpactTeams, error)
	Projects(context.Context, GitHubAppImpactQuery) (GitHubAppImpactProjects, error)
}

type GitHubAppImpactStore interface {
	ReadGitHubAppImpact(context.Context, func(GitHubAppImpactDAO) error) error
}
