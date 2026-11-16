package store

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

var ErrGitHubGrantIDConflict = errors.New("github grant ID is already used")
var ErrGitHubGrantExists = errors.New("github grant already exists")
var ErrGitHubGrantTeamRootMissing = errors.New("github grant Team root is missing")

type GitHubGrantTeam struct {
	model.TeamRef
	Version int64
}

type GitHubTeamGrant struct {
	ID, AppID string
	Team      GitHubGrantTeam
	CreatedAt time.Time
}

type GitHubGrantPreview struct {
	AppID      string
	Version    int64
	TargetTeam GitHubGrantTeam
	Grant      *GitHubTeamGrant
}

type GitHubTeamApp struct {
	GrantID, ID, Name, GitHubSlug string
	GitHubAppID, Version          int64
	CreatedAt                     time.Time
}

type GitHubGrantFacts struct {
	Team                      GitHubGrantTeam
	AppVersion, ImpactVersion int64
	IsAdmin                   bool
}

type GitHubGrantLocation struct {
	TeamID                    string
	Revoked                   bool
	AppVersion, ImpactVersion int64
}

// GitHubStopDecision selects the complete disconnection transition.
type GitHubStopDecision struct {
	Enabled, SyncEnabled bool
	AccessState          string
}

type GitHubGrantPage struct {
	Items   []GitHubTeamGrant
	HasMore bool
}
type GitHubTeamAppPage struct {
	Items   []GitHubTeamApp
	HasMore bool
}

// Read methods check the current actor before exposing target resources.
type GitHubGrantReadDAO interface {
	Locate(context.Context, string, string, string) (GitHubGrantLocation, error)
	Preview(context.Context, string, string, string) (GitHubGrantPreview, error)
	Grant(context.Context, string, string, string) (GitHubTeamGrant, error)
	Grants(context.Context, string, string, *string, int) (GitHubGrantPage, error)
	TeamApps(context.Context, string, string, *string, int) (GitHubTeamAppPage, error)
}

// The scope holds the Team root shared and then the App root exclusively.
// All decisions must re-read facts in this scope after the locks are held.
type GitHubGrantWriteDAO interface {
	Facts(context.Context, string) (GitHubGrantFacts, error)
	Grant(context.Context, string) (GitHubTeamGrant, error)
	LiveGrant(context.Context) (*GitHubTeamGrant, error)
	Insert(context.Context, string) (GitHubTeamGrant, error)
	Revoke(context.Context, string) error
	StopGrantConnections(context.Context, string, GitHubStopDecision) error
	AdvanceImpact(context.Context) error
}

// GitHubConnectionStopDAO is bound to the caller's transaction after the App
// root is locked. Its implementation never acquires Team or Project roots.
type GitHubConnectionStopDAO interface {
	StopGrantConnections(context.Context, string, GitHubStopDecision) error
	StopAppConnections(context.Context, GitHubStopDecision) error
	StopProjectConnection(context.Context, string, string, GitHubStopDecision) (bool, error)
	AdvanceImpact(context.Context) error
}

type GitHubGrantStore interface {
	ReadGitHubGrants(context.Context, func(GitHubGrantReadDAO) error) error
	WriteGitHubGrant(context.Context, string, string, string, func(GitHubGrantWriteDAO) error) (Completion, error)
}
