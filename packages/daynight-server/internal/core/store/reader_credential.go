package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type CredentialReader interface {
	Credential(context.Context, model.Principal) (ThreadCredential, error)
}
