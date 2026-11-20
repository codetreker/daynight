package server

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"time"
)

func assemblyAuthorization(p model.Principal) (model.CredentialAuthorization, error) {
	a := model.CredentialAuthorization{Principal: p}
	kind := scopepolicy.PAT
	switch p.Kind {
	case model.SessionCredential:
		a.Profile = model.SessionProfile
		return a, nil
	case model.PATCredential:
		a.Profile = model.ScopedPATProfile
	case model.OAuthCredential:
		a.Profile = model.ScopedMCPProfile
		kind = scopepolicy.MCP
	}
	entries, err := scopepolicy.Catalog(kind)
	if err != nil {
		return a, err
	}
	ids := make([]scopepolicy.ScopeID, 0, len(entries))
	for _, e := range entries {
		ids = append(ids, e.ID)
	}
	ids, err = scopepolicy.Normalize(kind, ids)
	if err != nil {
		return a, err
	}
	policy, err := scopepolicy.NewPolicy(kind, ids, 1)
	a.Policy = &policy
	return a, err
}
func assemblyPAT(p model.Principal, err error) (model.PersonalAccessToken, error) {
	if err != nil {
		return model.PersonalAccessToken{}, err
	}
	a, err := assemblyAuthorization(p)
	return model.PersonalAccessToken{ID: p.CredentialID, UserID: p.UserID, ScopePolicy: a.Policy}, err
}
func (s *httpTestSnapshot) CurrentCredentialAuthorization(_ context.Context, p model.Principal, _ string, _ bool) (model.CredentialAuthorization, error) {
	return assemblyAuthorization(p)
}
func (s *taskHTTPSnapshotScopeMock) CurrentCredentialAuthorization(_ context.Context, p model.Principal, _ string, _ bool) (model.CredentialAuthorization, error) {
	return assemblyAuthorization(p)
}
func (s sessionHTTPScope) CurrentCredentialAuthorization(_ context.Context, p model.Principal, _ string, _ bool) (model.CredentialAuthorization, error) {
	return assemblyAuthorization(p)
}
func (s startupCurrentScope) CurrentCredentialAuthorization(_ context.Context, p model.Principal, _ string, _ bool) (model.CredentialAuthorization, error) {
	return assemblyAuthorization(p)
}
func (s mcpBotScope) CurrentCredentialAuthorization(_ context.Context, p model.Principal, _ string, _ bool) (model.CredentialAuthorization, error) {
	return assemblyAuthorization(p)
}
func (s mcpBotSessionScope) CurrentCredentialAuthorization(_ context.Context, p model.Principal, _ string, _ bool) (model.CredentialAuthorization, error) {
	return assemblyAuthorization(p)
}
func (d *httpAuthenticationDAO) PATByHash(ctx context.Context, hash []byte, now time.Time) (model.PersonalAccessToken, error) {
	p, err := d.Authenticate(ctx, model.PATCredential, hash, now)
	return assemblyPAT(p, err)
}
func (d *mcpAuthenticationDAO) PATByHash(ctx context.Context, hash []byte, now time.Time) (model.PersonalAccessToken, error) {
	p, err := d.Authenticate(ctx, model.PATCredential, hash, now)
	return assemblyPAT(p, err)
}
func (d settingsHTTPIdentityDAO) PATByHash(ctx context.Context, hash []byte, now time.Time) (model.PersonalAccessToken, error) {
	p, err := d.Authenticate(ctx, model.PATCredential, hash, now)
	return assemblyPAT(p, err)
}
func (d *identityHTTPScope) PATByHash(ctx context.Context, hash []byte, now time.Time) (model.PersonalAccessToken, error) {
	p, err := d.Authenticate(ctx, model.PATCredential, hash, now)
	return assemblyPAT(p, err)
}

func (d httpRejectedIdentityDAO) ListPATScopes(context.Context, string) ([]model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "ListPATScopes")
	return nil, nil
}
func (d httpRejectedIdentityDAO) ReadLockedPATScope(context.Context, string, string) (model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "ReadLockedPATScope")
	return model.PersonalAccessToken{}, nil
}
func (d httpRejectedIdentityDAO) LockPATScope(context.Context, string, string) (model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "LockPATScope")
	return model.PersonalAccessToken{}, nil
}
func (d httpRejectedIdentityDAO) ComparePATScope(context.Context, string, string, int64, []scopepolicy.ScopeID, time.Time) (model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "ComparePATScope")
	return model.PersonalAccessToken{}, nil
}
func (d *oauthHTTPFamilyDAO) ScopedAccess(ctx context.Context, hash []byte, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	got, err := d.AuthenticateAccess(ctx, hash, bindings, now)
	if err != nil {
		return got, err
	}
	a, err := assemblyAuthorization(got.Principal)
	got.ScopePolicy = a.Policy
	return got, err
}
func (d usageAssemblyFamilyDAO) ScopedAccess(ctx context.Context, hash []byte, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	got, err := d.AuthenticateAccess(ctx, hash, bindings, now)
	if err != nil {
		return got, err
	}
	a, err := assemblyAuthorization(got.Principal)
	got.ScopePolicy = a.Policy
	return got, err
}
