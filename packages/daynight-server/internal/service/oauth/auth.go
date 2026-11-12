// Package oauth coordinates OAuth credential operations in caller-owned transactions.
package oauth

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Authenticator admits access tokens for the specified resource.
type Authenticator struct {
	writer             store.CredentialFamilyWriter
	authenticateAccess func(context.Context, store.CredentialFamilyDAO, string, string, time.Time) (store.OAuthAccessIdentity, error)
	apiOrigin          string
}

// SetOrigin binds the configured API audience before the authenticator is used.
func (a *Authenticator) SetOrigin(origin string) { a.apiOrigin = origin }

// RecheckAPIAccess admits the saved requester against its current application
// family. It uses access identity only and records no authentication usage.
func (a *Authenticator) RecheckAPIAccess(ctx context.Context, p model.Principal) error {
	if p.Kind != model.OAuthCredential || model.RequirePrincipal(p) != nil {
		return model.Unauthenticated(nil)
	}
	if !core.ValidAPIOrigin(a.apiOrigin) {
		return core.ErrInvalidAuthorization
	}
	completion, err := a.writer.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		err := scope.CredentialFamilyDAO().LockAccess(ctx, p, []store.OAuthBinding{{Resource: a.apiOrigin + "/api/v1", Scope: core.APIScope, ClientID: core.APIClientID}}, time.Now().UTC().Truncate(time.Microsecond))
		if errors.Is(err, model.ErrNotFound) {
			return model.Unauthenticated(err)
		}
		return err
	})
	if completion.Outcome == store.TransactionUnknown {
		var transaction *store.TransactionError
		if errors.As(err, &transaction) && transaction.Outcome == store.TransactionUnknown {
			return err
		}
		return &store.TransactionError{Phase: "confirmation", Outcome: store.TransactionUnknown, Cause: err}
	}
	if err != nil {
		return err
	}
	if completion.Outcome != store.TransactionCommitted {
		return &model.Fault{Code: "service_unavailable", Message: "OAuth access authority could not be confirmed."}
	}
	return nil
}

func NewAuthenticator(writer store.CredentialFamilyWriter) *Authenticator {
	return &Authenticator{writer: writer, authenticateAccess: core.AuthenticateAccess}
}

func (a *Authenticator) AuthenticateAccess(ctx context.Context, token, resource string) (store.OAuthAccessIdentity, error) {
	var result store.OAuthAccessIdentity
	completion, err := a.writer.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		var err error
		result, err = a.authenticateAccess(ctx, scope.CredentialFamilyDAO(), token, resource, time.Now().UTC())
		return err
	})
	if err != nil {
		return store.OAuthAccessIdentity{}, err
	}
	if completion.Outcome != store.TransactionCommitted {
		return store.OAuthAccessIdentity{}, errors.New("OAuth authentication transaction did not confirm commit")
	}
	return result, nil
}
