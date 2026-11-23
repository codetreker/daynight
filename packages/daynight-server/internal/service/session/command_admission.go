package session

import (
	"context"
	"errors"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// CommandAuthorizationSource reads and locks the original actor's current
// policy in the supplied transaction. OAuth implementations lock grant before
// access. The caller retains the scope through dispatch or refusal commit.
type CommandAuthorizationSource interface {
	SessionWrite(context.Context, store.SessionScope, model.Principal) (model.CredentialAuthorization, error)
}

func NewScopedCommands(writer store.SessionWriter, engine *sessioncore.Engine, source CommandAuthorizationSource) (*Service, error) {
	if source == nil {
		return nil, errors.New("session command authorization source is required")
	}
	s := New(writer, engine)
	if err := s.Execution.SetCommandAdmission(func(ctx context.Context, scope store.SessionScope, principal model.Principal, operation scopepolicy.Operation) error {
		return requireCommandAuthorization(ctx, source, scope, principal, operation)
	}); err != nil {
		return nil, err
	}
	s.scopedCommandExecution = s.Execution
	return s, nil
}

func requireCommandAuthorization(ctx context.Context, source CommandAuthorizationSource, scope store.SessionScope, principal model.Principal, operation scopepolicy.Operation) error {
	authorization, err := source.SessionWrite(ctx, scope, principal)
	if err != nil {
		return err
	}
	if authorization.Principal != principal {
		return errors.New("session command authorization principal mismatch")
	}
	return scopeadmission.Require(authorization, operation)
}

// TransactionCommandAuthorization obtains credential policy from the same
// Session transaction. Origin identifies the existing OAuth resource bindings.
type TransactionCommandAuthorization struct {
	Origin string
	Now    func() time.Time
}

func (s TransactionCommandAuthorization) SessionWrite(ctx context.Context, scope store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
	if p.Kind == model.SessionCredential {
		return model.CredentialAuthorization{Principal: p, Profile: model.SessionProfile}, nil
	}
	credentials, ok := scope.(store.SessionCredentialScope)
	if !ok {
		return model.CredentialAuthorization{}, errors.New("session transaction cannot recheck credential policy")
	}
	now := time.Now()
	if s.Now != nil {
		now = s.Now()
	}
	switch p.Kind {
	case model.PATCredential:
		return identity.NewIdentity("").LockPATAuthorization(ctx, credentials.SessionPATScopeDAO(), credentials.SessionPATManagementDAO(), p, now)
	case model.OAuthCredential:
		bindings := []store.OAuthBinding{
			{Resource: s.Origin + "/api/v1", Scope: oauth.APIScope, ClientID: oauth.APIClientID},
			{Resource: s.Origin + "/mcp", Scope: oauth.Scope},
		}
		access, err := credentials.SessionOAuthScopeDAO().LockScopedAccess(ctx, p, bindings, now)
		if errors.Is(err, model.ErrNotFound) {
			return model.CredentialAuthorization{}, model.Unauthenticated(err)
		}
		if err != nil {
			return model.CredentialAuthorization{}, err
		}
		if access.Principal != p {
			return model.CredentialAuthorization{}, model.Unauthenticated(nil)
		}
		profile := model.OAuthAPIProfile
		if access.ScopePolicy != nil {
			profile = model.ScopedMCPProfile
		}
		a := model.CredentialAuthorization{Principal: p, Profile: profile, Policy: access.ScopePolicy}
		if err := a.Validate(); err != nil {
			return model.CredentialAuthorization{}, err
		}
		return a, nil
	default:
		return model.CredentialAuthorization{}, model.Unauthenticated(nil)
	}
}
