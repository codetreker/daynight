package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

// GitHubAppCredentialReader reads the current credentials of a live App. It
// does not authorize their use; callers must apply their own access checks.
type GitHubAppCredentialReader interface {
	Credentials(context.Context, string) (githubpr.CredentialSnapshot, error)
}
