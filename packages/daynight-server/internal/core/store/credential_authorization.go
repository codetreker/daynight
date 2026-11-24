package store

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// CredentialAuthorizationScope reads current policy in its owning transaction.
// Writes hold the credential lock until commit, with OAuth grant before access.
type CredentialAuthorizationScope interface {
	CurrentCredentialAuthorization(context.Context, model.Principal, string, bool) (model.CredentialAuthorization, error)
}
