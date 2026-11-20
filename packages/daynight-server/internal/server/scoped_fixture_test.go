package server

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"testing"
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

func (d *identityHTTPScope) FreshPATTime(_ context.Context, now time.Time) (time.Time, error) {
	identityHTTPNow(d.t, now)
	return now, nil
}
func (d *identityHTTPScope) ListAllPATs(context.Context, string) ([]model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "ListAllPATs")
	return nil, nil
}
func (d *identityHTTPScope) ComparePATDescription(context.Context, string, string, *string, *string) (bool, error) {
	unexpectedHTTPCall(d.t, "ComparePATDescription")
	return false, nil
}
func (d *identityHTTPScope) PATExists(context.Context, string, string) (bool, error) {
	unexpectedHTTPCall(d.t, "PATExists")
	return false, nil
}

func (s projectHTTPSnapshot) CurrentCredentialAuthorization(_ context.Context, p model.Principal, _ string, _ bool) (model.CredentialAuthorization, error) {
	return assemblyAuthorization(p)
}

type assemblySessionPAT struct {
	store.PATScopeDAO
	store.PATManagementDAO
	t         *testing.T
	principal model.Principal
}

func (d assemblySessionPAT) ReadLockedPATScope(ctx context.Context, user, id string) (model.PersonalAccessToken, error) {
	p := model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: id}
	projectHTTPCheck(d.t, p, d.principal)
	return assemblyPAT(p, nil)
}
func (d assemblySessionPAT) FreshPATTime(_ context.Context, now time.Time) (time.Time, error) {
	return now, nil
}
func (s startupCurrentScope) SessionPATScopeDAO() store.PATScopeDAO {
	return assemblySessionPAT{t: s.dao.t, principal: s.dao.f.handler.principal}
}
func (s startupCurrentScope) SessionPATManagementDAO() store.PATManagementDAO {
	return assemblySessionPAT{t: s.dao.t, principal: s.dao.f.handler.principal}
}
func (s startupCurrentScope) SessionOAuthScopeDAO() store.OAuthScopeDAO {
	unexpectedHTTPCall(s.dao.t, "SessionOAuthScopeDAO")
	return nil
}
func (s sessionHTTPScope) SessionPATScopeDAO() store.PATScopeDAO {
	return assemblySessionPAT{t: s.t, principal: s.dao.f.handler.principal}
}
func (s sessionHTTPScope) SessionPATManagementDAO() store.PATManagementDAO {
	return assemblySessionPAT{t: s.t, principal: s.dao.f.handler.principal}
}
func (s sessionHTTPScope) SessionOAuthScopeDAO() store.OAuthScopeDAO {
	panic("unexpected OAuth Session fixture")
}

func (s accessHTTPSnapshot) CurrentCredentialAuthorization(_ context.Context, p model.Principal, _ string, _ bool) (model.CredentialAuthorization, error) {
	return assemblyAuthorization(p)
}
func (s settingsHTTPSnapshot) CurrentCredentialAuthorization(_ context.Context, p model.Principal, _ string, _ bool) (model.CredentialAuthorization, error) {
	return assemblyAuthorization(p)
}
func (s teamHTTPSnapshot) CurrentCredentialAuthorization(_ context.Context, p model.Principal, _ string, _ bool) (model.CredentialAuthorization, error) {
	return assemblyAuthorization(p)
}
