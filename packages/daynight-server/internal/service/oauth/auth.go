// Package oauth coordinates OAuth credential operations in caller-owned transactions.
package oauth

import (
	"context"
	"errors"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// Authenticator admits access tokens for the specified resource.
type Authenticator struct {
	writer             store.CredentialFamilyWriter
	authenticateAccess func(context.Context, store.CredentialFamilyDAO, string, string, time.Time) (store.OAuthAccessIdentity, error)
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
