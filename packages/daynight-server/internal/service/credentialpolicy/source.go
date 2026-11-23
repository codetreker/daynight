// Package credentialpolicy binds policy reads to application transactions.
package credentialpolicy

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"time"
)

type Source struct {
	Database store.Transactions
	Origin   string
}

func (s *Source) InScope(ctx context.Context, scope any, p model.Principal, lock bool) (model.CredentialAuthorization, error) {
	r, ok := scope.(store.CredentialAuthorizationScope)
	if !ok {
		return model.CredentialAuthorization{}, errors.New("transaction credential authorization is unavailable")
	}
	a, err := r.CurrentCredentialAuthorization(ctx, p, s.Origin, lock)
	if err != nil {
		return model.CredentialAuthorization{}, err
	}
	if a.Principal != p {
		return model.CredentialAuthorization{}, model.Unauthenticated(nil)
	}
	return a, a.Validate()
}
func (s *Source) Current(ctx context.Context, p model.Principal) (a model.CredentialAuthorization, err error) {
	err = s.Database.ReadSnapshot(ctx, func(sc store.SnapshotScope) error { var e error; a, e = s.Read(ctx, sc, p); return e })
	return
}
func (s *Source) Refresh(ctx context.Context, original model.CredentialAuthorization) (model.CredentialAuthorization, error) {
	a, err := s.Current(ctx, original.Principal)
	if err != nil {
		return a, err
	}
	if a.Profile != original.Profile {
		return model.CredentialAuthorization{}, model.Unauthenticated(nil)
	}
	return a, nil
}
func (s *Source) Read(ctx context.Context, sc store.SnapshotScope, p model.Principal) (model.CredentialAuthorization, error) {
	return s.InScope(ctx, sc, p, false)
}
func (s *Source) WorkerWrite(ctx context.Context, sc store.WorkerScope, p model.Principal) (model.CredentialAuthorization, error) {
	return s.InScope(ctx, sc, p, true)
}
func (s *Source) BotWrite(ctx context.Context, sc store.BotScope, p model.Principal) (model.CredentialAuthorization, error) {
	return s.InScope(ctx, sc, p, true)
}
func (s *Source) SessionWrite(ctx context.Context, sc store.SessionScope, p model.Principal) (model.CredentialAuthorization, error) {
	return s.InScope(ctx, sc, p, true)
}
func (s *Source) TeamWrite(ctx context.Context, sc store.TeamWriteScope, p model.Principal) (model.CredentialAuthorization, error) {
	return s.InScope(ctx, sc, p, true)
}
func (s *Source) ProjectWrite(ctx context.Context, sc store.ProjectDirectMemberScope, p model.Principal) (model.CredentialAuthorization, error) {
	return s.InScope(ctx, sc, p, true)
}
func (s *Source) PromptRead(ctx context.Context, sc store.PromptSnapshot, p model.Principal) (model.CredentialAuthorization, error) {
	return s.InScope(ctx, sc, p, false)
}
func (s *Source) Usage(ctx context.Context, sc store.UsageScope, p model.Principal, _ time.Time, write bool) (model.CredentialAuthorization, error) {
	return s.InScope(ctx, sc, p, write)
}
func (s *Source) ProfileWrite(ctx context.Context, sc store.IdentityScope, p model.Principal) (model.CredentialAuthorization, error) {
	if p.Kind == model.SessionCredential {
		return model.CredentialAuthorization{Principal: p, Profile: model.SessionProfile}, nil
	}
	if p.Kind == model.PATCredential {
		dao, ok := sc.IdentityDAO().(store.PATScopeDAO)
		if !ok {
			return model.CredentialAuthorization{}, errors.New("PAT policy DAO unavailable")
		}
		clock, ok := sc.IdentityDAO().(store.PATManagementDAO)
		if !ok {
			return model.CredentialAuthorization{}, errors.New("PAT policy clock unavailable")
		}
		return identity.NewIdentity("").LockPATAuthorization(ctx, dao, clock, p, time.Now().UTC())
	}
	dao, ok := sc.CredentialFamilyDAO().(store.OAuthScopeDAO)
	if !ok {
		return model.CredentialAuthorization{}, errors.New("OAuth policy DAO unavailable")
	}
	a, err := oauth.LockAccessPolicy(ctx, dao, p, s.Origin+"/api/v1", time.Now().UTC())
	return a.Authorization, err
}

func (s *Source) Authenticate(ctx context.Context, kind model.CredentialKind, token, resource string) (a model.CredentialAuthorization, authority string, err error) {
	if kind == model.PATCredential {
		_, err = s.Database.WriteIdentity(ctx, func(sc store.IdentityScope) error {
			d, ok := sc.IdentityDAO().(store.PATScopeDAO)
			if !ok {
				return errors.New("PAT policy DAO unavailable")
			}
			var e error
			a, e = identity.NewIdentity("").AuthenticatePATPolicy(ctx, d, token, time.Now().UTC())
			return e
		})
		authority = a.Principal.CredentialID
		return
	}
	if kind != model.OAuthCredential || resource != s.Origin+"/mcp" {
		return a, "", model.Unauthenticated(nil)
	}
	_, err = s.Database.WriteCredentialFamily(ctx, func(sc store.CredentialFamilyScope) error {
		d, ok := sc.CredentialFamilyDAO().(store.OAuthScopeDAO)
		if !ok {
			return errors.New("OAuth policy DAO unavailable")
		}
		policy, e := oauth.AuthenticateAccessPolicy(ctx, d, token, resource, time.Now().UTC())
		a, authority = policy.Authorization, policy.GrantID
		return e
	})
	return
}
