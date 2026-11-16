package store

import (
	"context"
	"errors"
	"time"
)

// GitHubAppWorkIdentity is captured at admission and retained for the entire job.
// A later grant or credential version cannot authorize an earlier execution.
type GitHubAppWorkIdentity struct {
	AppResourceID, GrantID, TeamID string
	AppID, CredentialVersion       int64
}

var ErrGitHubAppWorkUnavailable = errors.New("github App work authorization is no longer current")

type GitHubAppWorkDAO interface {
	GitHubWorkDAO
	Identity() GitHubAppWorkIdentity
}

// GitHubAppWorkWriter freezes the live Project, ownership, Team, App, grant and
// connection in that lock order. Nil expected captures current admission identity;
// an expected identity requires the exact original authorization on every call.
type GitHubAppWorkWriter interface {
	WriteGitHubAppWork(context.Context, string, *GitHubAppWorkIdentity, func(GitHubAppWorkDAO) error) (Completion, error)
}

type GitHubAppWorkReader interface {
	DueGitHubAppProjects(context.Context, time.Time, int) ([]string, error)
}
