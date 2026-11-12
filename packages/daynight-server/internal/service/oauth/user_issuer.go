package oauth

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// UserAPIIssuer initializes a complete account before independently committing
// its application credential family. A later family failure retains the account.
type UserAPIIssuer struct {
	ensureUser func(context.Context, model.User) (model.User, error)
	issue      func(context.Context, string) (core.IssuedFamily, error)
}

func NewUserAPIIssuer(writer store.CredentialFamilyWriter, ensureUser func(context.Context, model.User) (model.User, error), origin string) (*UserAPIIssuer, error) {
	if ensureUser == nil {
		return nil, core.ErrInvalidAuthorization
	}
	issuer, err := NewAPIIssuer(writer, origin)
	if err != nil {
		return nil, err
	}
	return &UserAPIIssuer{ensureUser: ensureUser, issue: issuer.Issue}, nil
}

func (s *UserAPIIssuer) Issue(ctx context.Context, input model.User) (core.IssuedFamily, error) {
	user, err := s.ensureUser(ctx, input)
	if err != nil {
		return core.IssuedFamily{}, err
	}
	return s.issue(ctx, user.ID)
}
