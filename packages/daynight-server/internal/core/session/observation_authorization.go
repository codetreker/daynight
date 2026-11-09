package session

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// AuthorizeTaskObservation admits only the Task observation purpose. It does not
// change Controller, independent Session, command or archive-upload admission.
func AuthorizeTaskObservation(ctx context.Context, reader store.CredentialReader, p model.Principal) error {
	if err := model.RequirePrincipal(p); err != nil {
		return err
	}
	if _, err := reader.Credential(ctx, p); err != nil {
		if errors.Is(err, model.ErrNotFound) {
			return &model.Fault{Code: "unauthenticated", Message: "Credential expired or was revoked.", Cause: err}
		}
		return err
	}
	return nil
}
