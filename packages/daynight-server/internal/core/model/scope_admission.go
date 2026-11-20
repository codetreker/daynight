package model

import (
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// Require checks an authenticated policy snapshot against all operations. Fixed
// profiles retain their existing authorization rules; callers still enforce
// resource access and the profile's other restrictions.
func (a CredentialAuthorization) Require(operations ...scopepolicy.Operation) error {
	if err := a.Validate(); err != nil {
		return err
	}
	required, err := scopepolicy.Requirements(operations...)
	if err != nil {
		return err
	}
	if a.Policy == nil {
		return nil
	}
	if err := a.Policy.Require(required...); err != nil {
		if errors.Is(err, scopepolicy.ErrInsufficientScope) {
			return &Fault{Code: "insufficient_scope", Message: "Credential scope is insufficient.", Cause: err}
		}
		return err
	}
	return nil
}
