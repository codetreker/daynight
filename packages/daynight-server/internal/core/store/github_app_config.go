package store

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

// GitHubAppConfigFacts is an internal, secret-bearing snapshot, never a public projection.
type GitHubAppConfigFacts struct {
	App                                                 githubpr.AppMetadata
	CredentialVersion, ImpactVersion, MembershipVersion int64
	Credentials                                         githubpr.AppCredentials
	HasImpact                                           bool
}
type GitHubAppConfigUpdate struct {
	Name, GitHubName, GitHubSlug string
	Version, CredentialVersion   int64
	Credentials                  githubpr.AppCredentials
}
type GitHubAppCredentialFence struct {
	CredentialVersion  int64
	AccessState        string
	ScheduleSyncAccess bool
}
type GitHubAppConfigReader interface {
	Facts(context.Context, string) (GitHubAppConfigFacts, error)
}

// GitHubAppConfigAccess contains only the facts needed to establish an App
// administrator's visibility and the current versions before scope admission.
type GitHubAppConfigAccess struct {
	AppVersion, ImpactVersion, MembershipVersion int64
}

// GitHubAppConfigAccessReader reads access facts without loading credentials.
// The capability is used in the same scope as the subsequent configuration read.
type GitHubAppConfigAccessReader interface {
	ConfigAccess(context.Context, string) (GitHubAppConfigAccess, error)
}

// GitHubAppConfigWriter is bound to the live App root locked by its scope.
type GitHubAppConfigWriter interface {
	GitHubAppConfigReader
	Update(context.Context, GitHubAppConfigUpdate) (githubpr.AppMetadata, error)
	FenceConnections(context.Context, GitHubAppCredentialFence) error
	StopAppConnections(context.Context, GitHubStopDecision) error
	RemoveRelations(context.Context) error
	Tombstone(context.Context, int64) error
}
type GitHubAppConfigStore interface {
	ReadGitHubAppConfig(context.Context, string, func(GitHubAppConfigReader) error) error
	WriteGitHubAppConfig(context.Context, string, func(GitHubAppConfigWriter) error) (Completion, error)
}
