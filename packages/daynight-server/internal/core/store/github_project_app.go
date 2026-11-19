package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

type GitHubProjectAppFacts struct {
	Project                model.Project
	Access                 model.ProjectAccess
	Connection             githubpr.Connection
	AppResourceID, GrantID *string
	CredentialVersion      *int64
	RepositoryVersion      int64
}

// GitHubProjectApp contains the Team usage projection and proof conditions.
type GitHubProjectApp struct {
	ID, Name, GitHubSlug                    string
	GitHubAppID, Version, CredentialVersion int64
}

type GitHubProjectAppReadDAO interface {
	Facts(context.Context, model.Principal) (GitHubProjectAppFacts, error)
	App(context.Context, string, string, string) (GitHubProjectApp, error)
}

type GitHubProjectAppWrite struct {
	Configuration          GitHubConfigurationWrite
	AppResourceID, GrantID *string
	CredentialVersion      *int64
	ClearWork              bool
}

// Write scopes hold Project, ownership, Team, sorted App roots and grants before
// locking the connection. Facts is reread after every preceding lock wait.
type GitHubProjectAppWriteDAO interface {
	GitHubProjectAppReadDAO
	ObservedAt(context.Context) (time.Time, error)
	Save(context.Context, GitHubProjectAppWrite) (bool, error)
	AdvanceImpact(context.Context, string) error
}

type GitHubProjectAppStore interface {
	ReadGitHubProjectApp(context.Context, string, func(GitHubProjectAppReadDAO) error) error
	WriteGitHubProjectApp(context.Context, string, string, string, func(GitHubProjectAppWriteDAO) error) (Completion, error)
}
