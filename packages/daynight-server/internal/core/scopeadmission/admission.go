// Package scopeadmission applies business scope requirements to an authenticated
// credential snapshot. Existing resource and profile checks remain mandatory.
package scopeadmission

import (
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// Require validates the credential profile and requires every operation for a
// scoped credential. Fixed profiles retain their existing business restrictions.
func Require(auth model.CredentialAuthorization, operations ...scopepolicy.Operation) error {
	if err := auth.Validate(); err != nil {
		return err
	}
	required, err := scopepolicy.Requirements(operations...)
	if err != nil {
		return err
	}
	if auth.Policy == nil {
		return nil
	}
	if err := auth.Policy.Require(required...); err != nil {
		if errors.Is(err, scopepolicy.ErrInsufficientScope) {
			return &model.Fault{Code: "insufficient_scope", Message: "The credential has insufficient scope.", Cause: err}
		}
		return err
	}
	return nil
}
