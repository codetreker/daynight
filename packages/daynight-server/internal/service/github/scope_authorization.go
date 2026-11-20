package github

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// AuthorizationReader retrieves current authority for the original credential.
// Scoped operations which continue after remote proof require this capability.
type AuthorizationReader func(context.Context, model.CredentialAuthorization) (model.CredentialAuthorization, error)

func currentAdmission(ctx context.Context, reader AuthorizationReader, original model.CredentialAuthorization, operations ...scopepolicy.Operation) error {
	if original.Profile != model.ScopedPATProfile && original.Profile != model.ScopedMCPProfile {
		return scopeadmission.Require(original, operations...)
	}
	if reader == nil {
		return errors.New("current credential authorization unavailable")
	}
	current, err := reader(ctx, original)
	if err != nil {
		return err
	}
	if current.Principal != original.Principal || current.Profile != original.Profile {
		return model.Unauthenticated(nil)
	}
	return scopeadmission.Require(current, operations...)
}
