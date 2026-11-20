package session

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type policySessionDAO struct {
	store.SessionDAO
	lock func(context.Context, model.Principal, time.Time) error
}

func (d policySessionDAO) LockCredential(c context.Context, p model.Principal, n time.Time) error {
	return d.lock(c, p, n)
}

type policyPAT struct {
	store.PATScopeDAO
	read func(context.Context, string, string) (model.PersonalAccessToken, error)
}

func (d policyPAT) ReadLockedPATScope(c context.Context, u, id string) (model.PersonalAccessToken, error) {
	return d.read(c, u, id)
}

type policyClock struct {
	store.PATManagementDAO
	read func(context.Context, time.Time) (time.Time, error)
}

func (d policyClock) FreshPATTime(c context.Context, n time.Time) (time.Time, error) {
	return d.read(c, n)
}

type policyOAuth struct {
	store.OAuthScopeDAO
	lock func(context.Context, model.Principal, []store.OAuthBinding, time.Time) (store.OAuthAccessIdentity, error)
}

func (d policyOAuth) LockScopedAccess(c context.Context, p model.Principal, b []store.OAuthBinding, n time.Time) (store.OAuthAccessIdentity, error) {
	return d.lock(c, p, b, n)
}

type policySessionScope struct {
	store.SessionScope
	session store.SessionDAO
	pat     store.PATScopeDAO
	clock   store.PATManagementDAO
	oauth   store.OAuthScopeDAO
}

func (s policySessionScope) SessionDAO() store.SessionDAO                    { return s.session }
func (s policySessionScope) SessionPATScopeDAO() store.PATScopeDAO           { return s.pat }
func (s policySessionScope) SessionPATManagementDAO() store.PATManagementDAO { return s.clock }
func (s policySessionScope) SessionOAuthScopeDAO() store.OAuthScopeDAO       { return s.oauth }

type policySnapshot struct {
	store.SnapshotScope
	pat        func(context.Context, model.Principal, time.Time) (model.PersonalAccessToken, error)
	oauth      func(context.Context, model.Principal, []store.OAuthBinding, time.Time) (store.OAuthAccessIdentity, error)
	credential store.CredentialReader
}

func (s policySnapshot) SessionPATPolicy(c context.Context, p model.Principal, n time.Time) (model.PersonalAccessToken, error) {
	return s.pat(c, p, n)
}
func (s policySnapshot) SessionOAuthPolicy(c context.Context, p model.Principal, b []store.OAuthBinding, n time.Time) (store.OAuthAccessIdentity, error) {
	return s.oauth(c, p, b, n)
}
func (s policySnapshot) CredentialDAO() store.CredentialReader { return s.credential }

type policyCredential struct {
	read func(context.Context, model.Principal) (store.ThreadCredential, error)
}

func (d policyCredential) Credential(c context.Context, p model.Principal) (store.ThreadCredential, error) {
	return d.read(c, p)
}

func TestSessionAuthorizationSourcesReadCurrentPolicy(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	source := NewSessionAuthorizationSource("https://example.test")
	source.now = func() time.Time { return now }
	ctx := t.Context()
	for _, profile := range []model.CredentialPolicyProfile{model.ScopedPATProfile, model.ScopedMCPProfile, model.OAuthAPIProfile, model.SessionProfile} {
		t.Run(string(profile), func(t *testing.T) {
			p := model.Principal{Kind: model.OAuthCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
			kind := scopepolicy.MCP
			if profile == model.ScopedPATProfile {
				p.Kind = model.PATCredential
				kind = scopepolicy.PAT
			}
			if profile == model.SessionProfile {
				p.Kind = model.SessionCredential
			}
			old, _ := scopepolicy.NewPolicy(kind, []scopepolicy.ScopeID{"session:read"}, 1)
			current, _ := scopepolicy.NewPolicy(kind, []scopepolicy.ScopeID{"session:send"}, 2)
			original := model.CredentialAuthorization{Principal: p, Profile: profile}
			if profile == model.ScopedPATProfile || profile == model.ScopedMCPProfile {
				original.Policy = &old
			}
			future := now.Add(time.Hour)
			var calls []string
			snap := policySnapshot{pat: func(c context.Context, got model.Principal, n time.Time) (model.PersonalAccessToken, error) {
				if c != ctx || got != p || n != now {
					t.Fatal("wrong PAT input")
				}
				calls = append(calls, "pat")
				return model.PersonalAccessToken{ID: p.CredentialID, UserID: p.UserID, ScopePolicy: &current, ExpiresAt: &future}, nil
			}, oauth: func(c context.Context, got model.Principal, b []store.OAuthBinding, n time.Time) (store.OAuthAccessIdentity, error) {
				calls = append(calls, "oauth")
				if c != ctx || got != p || n != now {
					t.Fatal("wrong OAuth input")
				}
				want := store.OAuthBinding{Resource: "https://example.test/mcp", Scope: oauth.Scope}
				if profile == model.OAuthAPIProfile {
					want = store.OAuthBinding{Resource: "https://example.test/api/v1", Scope: oauth.APIScope, ClientID: oauth.APIClientID}
				}
				if !reflect.DeepEqual(b, []store.OAuthBinding{want}) {
					t.Fatalf("binding %v", b)
				}
				var pol *scopepolicy.Policy
				if profile == model.ScopedMCPProfile {
					pol = &current
				}
				return store.OAuthAccessIdentity{Principal: p, GrantID: "33333333-3333-4333-8333-333333333333", ExpiresAt: future, ScopePolicy: pol}, nil
			}, credential: policyCredential{read: func(c context.Context, got model.Principal) (store.ThreadCredential, error) {
				if c != ctx || got != p {
					t.Fatal("wrong session input")
				}
				calls = append(calls, "session")
				return store.ThreadCredential{}, nil
			}}}
			got, err := source.SessionSnapshot(ctx, snap, original)
			if err != nil {
				t.Fatal(err)
			}
			if got.Principal != p || got.Profile != profile || len(calls) != 1 {
				t.Fatalf("snapshot got %#v %v", got, calls)
			}
			if original.Policy != nil && (got.Policy == nil || got.Policy.Version() != 2) {
				t.Fatalf("stale snapshot policy %#v", got)
			}
			calls = nil
			tx := policySessionScope{session: policySessionDAO{lock: func(c context.Context, got model.Principal, n time.Time) error {
				if c != ctx || got != p || n != now {
					t.Fatal("wrong session lock")
				}
				calls = append(calls, "session")
				return nil
			}}, pat: policyPAT{read: func(c context.Context, u, id string) (model.PersonalAccessToken, error) {
				if c != ctx || u != p.UserID || id != p.CredentialID {
					t.Fatal("wrong PAT lock")
				}
				calls = append(calls, "pat")
				return model.PersonalAccessToken{ID: id, UserID: u, ScopePolicy: &current, ExpiresAt: &future}, nil
			}}, clock: policyClock{read: func(c context.Context, n time.Time) (time.Time, error) { calls = append(calls, "clock"); return n, nil }}, oauth: policyOAuth{lock: func(c context.Context, got model.Principal, b []store.OAuthBinding, n time.Time) (store.OAuthAccessIdentity, error) {
				v, e := snap.oauth(c, got, b, n)
				v.GrantID = "33333333-3333-4333-8333-333333333333"
				return v, e
			}}}
			got, err = source.SessionWrite(ctx, tx, original)
			if err != nil {
				t.Fatal(err)
			}
			if got.Principal != p || got.Profile != profile {
				t.Fatalf("write %#v", got)
			}
			if original.Policy != nil && (got.Policy == nil || got.Policy.Version() != 2) {
				t.Fatalf("stale write policy %#v", got)
			}
			if profile == model.ScopedPATProfile && !reflect.DeepEqual(calls, []string{"pat", "clock"}) {
				t.Fatalf("PAT order %v", calls)
			}
		})
	}
}

func TestSessionAuthorizationRefusesMissingAndMismatchedFacts(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	source := NewSessionAuthorizationSource("https://example.test")
	source.now = func() time.Time { return now }
	p := model.Principal{Kind: model.PATCredential, UserID: "11111111-1111-4111-8111-111111111111", CredentialID: "22222222-2222-4222-8222-222222222222"}
	policy, _ := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"session:read"}, 1)
	original := model.CredentialAuthorization{Principal: p, Profile: model.ScopedPATProfile, Policy: &policy}
	for _, tc := range []struct {
		name    string
		token   model.PersonalAccessToken
		failure error
	}{
		{name: "revoked", failure: model.ErrNotFound},
		{name: "mismatched", token: model.PersonalAccessToken{ID: "other", UserID: p.UserID, ScopePolicy: &policy}},
		{name: "missing policy", token: model.PersonalAccessToken{ID: p.CredentialID, UserID: p.UserID}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			snap := policySnapshot{pat: func(context.Context, model.Principal, time.Time) (model.PersonalAccessToken, error) {
				return tc.token, tc.failure
			}}
			if _, err := source.SessionSnapshot(t.Context(), snap, original); err == nil {
				t.Fatal("invalid credential accepted")
			}
		})
	}
	cause := errors.New("database failure")
	snap := policySnapshot{pat: func(context.Context, model.Principal, time.Time) (model.PersonalAccessToken, error) {
		return model.PersonalAccessToken{}, cause
	}}
	if _, err := source.SessionSnapshot(t.Context(), snap, original); !errors.Is(err, cause) {
		t.Fatal(err)
	}
}
