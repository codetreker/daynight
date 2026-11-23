package mcp

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialpolicy"
)

type PolicyAuthenticator struct{ Source *credentialpolicy.Source }

func (a PolicyAuthenticator) AuthenticateScoped(ctx context.Context, kind model.CredentialKind, token, resource string) (model.CredentialAuthorization, AuthorityRef, error) {
	policy, id, err := a.Source.Authenticate(ctx, kind, token, resource)
	authority := AuthorityRef{Kind: "pat", ID: id}
	if kind == model.OAuthCredential {
		authority.Kind = "oauth"
	}
	return policy, authority, err
}
