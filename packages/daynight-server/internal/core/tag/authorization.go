package tag

import (
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// RequireAuthorization is called after resource visibility is established and
// before catalog data is read or changed. Full write responses include existing
// fields and usage, so those operations also require catalog read permission.
func RequireAuthorization(auth model.CredentialAuthorization, operation scopepolicy.Operation) error {
	if err := auth.Validate(); err != nil {
		return err
	}
	operations := []scopepolicy.Operation{operation}
	switch operation {
	case scopepolicy.TagRead, scopepolicy.TagDelete:
	case scopepolicy.TagWrite:
		operations = append(operations, scopepolicy.TagRead)
	default:
		return fmt.Errorf("unsupported tag operation %q", operation)
	}
	if auth.Profile == model.SessionProfile || auth.Profile == model.OAuthAPIProfile {
		return nil
	}
	required, err := scopepolicy.Requirements(operations...)
	if err != nil {
		return err
	}
	if err := auth.Policy.Require(required...); err != nil {
		return Fault("insufficient_scope", "The credential lacks the required tag scope.", err)
	}
	return nil
}
