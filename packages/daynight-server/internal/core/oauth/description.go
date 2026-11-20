package oauth

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialdescription"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// UpdateSessionGrantDescription compares the observed value within the grant
// transaction and rechecks the locked browser session after all lock waits.
func (s *GrantLifecycle) UpdateSessionGrantDescription(ctx context.Context, principal model.Principal, expectedUserID, grantID string, expectedDescription, description *string) (*string, error) {
	if !validOwnerSession(principal) {
		return nil, model.Unauthenticated(nil)
	}
	if !validID(expectedUserID) || !validID(grantID) || credentialdescription.ValidateExpected(expectedDescription) != nil {
		return nil, invalidInput()
	}
	if expectedUserID != principal.UserID {
		return nil, &model.Fault{Code: "identity_mismatch", Message: "The current account differs from the expected account."}
	}
	normalized, err := credentialdescription.Normalize(description)
	if err != nil {
		return nil, invalidInput()
	}
	c, err := s.writer.WriteGrantLifecycle(ctx, func(d store.GrantLifecycleDAO) error {
		changed, err := d.UpdateOwnerGrantDescription(ctx, principal.UserID, grantID, expectedDescription, normalized)
		if err != nil {
			return err
		}
		var exists bool
		if !changed {
			exists, err = d.OwnerGrantExists(ctx, principal.UserID, grantID)
			if err != nil {
				return err
			}
		}
		// The initial time precedes the session lock wait. Rechecking after
		// acquiring the lock samples the database clock while holding it.
		if err := s.checkOwnerSession(ctx, d, principal); err != nil {
			return err
		}
		if err := s.checkOwnerSession(ctx, d, principal); err != nil {
			return err
		}
		if !changed {
			if !exists {
				return model.ErrNotFound
			}
			return &model.Fault{Code: "version_conflict", Message: "The grant description has changed."}
		}
		return nil
	})
	if err := lifecycleCompletion(c, err); err != nil {
		return nil, err
	}
	return normalized, nil
}
