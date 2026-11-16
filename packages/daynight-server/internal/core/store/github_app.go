package store

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

var (
	ErrGitHubAppIDConflict         = errors.New("github app ID is already registered")
	ErrGitHubAppResourceIDConflict = errors.New("github app resource ID is already used")
)

type GitHubAppCreate struct {
	ID                                          string
	GitHubAppID                                 int64
	Name, GitHubName, GitHubSlug, CreatorUserID string
	Credentials                                 githubpr.AppCredentials
}

type GitHubAppQuery struct {
	ActorID string
	After   *Position
	Limit   int
}

type GitHubAppPage struct {
	Items   []githubpr.AppMetadata
	HasMore bool
}

// GitHubAppWriteDAO is valid only inside its transaction. Create inserts the
// App and its first administrator together; an error must abort the scope.
type GitHubAppWriteDAO interface {
	Create(context.Context, GitHubAppCreate) (githubpr.AppMetadata, error)
}

// GitHubAppReadDAO returns only live resources currently managed by the actor.
type GitHubAppReadDAO interface {
	Get(context.Context, string, string) (githubpr.AppMetadata, error)
	List(context.Context, GitHubAppQuery) (GitHubAppPage, error)
}

type GitHubAppStore interface {
	WriteGitHubApp(context.Context, func(GitHubAppWriteDAO) error) (Completion, error)
	ReadGitHubApps(context.Context, func(GitHubAppReadDAO) error) error
}
