package credentialpolicy

import (
	"context"
	"errors"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"testing"
	"time"
)

type policyScope struct {
	store.SnapshotScope
	result  model.CredentialAuthorization
	err     error
	locks   []bool
	origins []string
}

func (s *policyScope) CurrentCredentialAuthorization(_ context.Context, p model.Principal, origin string, lock bool) (model.CredentialAuthorization, error) {
	s.locks = append(s.locks, lock)
	s.origins = append(s.origins, origin)
	return s.result, s.err
}

type policyDatabase struct {
	store.Transactions
	snapshot store.SnapshotScope
	identity store.IdentityScope
	family   store.CredentialFamilyScope
}

func (d policyDatabase) ReadSnapshot(ctx context.Context, f func(store.SnapshotScope) error) error {
	return f(d.snapshot)
}
func (d policyDatabase) WriteIdentity(ctx context.Context, f func(store.IdentityScope) error) (store.Completion, error) {
	return store.Completion{Outcome: store.TransactionCommitted}, f(d.identity)
}
func (d policyDatabase) WriteCredentialFamily(ctx context.Context, f func(store.CredentialFamilyScope) error) (store.Completion, error) {
	return store.Completion{Outcome: store.TransactionCommitted}, f(d.family)
}
func testAuthorization(t *testing.T) model.CredentialAuthorization {
	t.Helper()
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	return model.CredentialAuthorization{Principal: model.Principal{Kind: model.PATCredential, UserID: "00000000-0000-4000-8000-000000000001", CredentialID: "00000000-0000-4000-8000-000000000002"}, Profile: model.ScopedPATProfile, Policy: &policy}
}
func TestPolicyReadsAreBoundAndFailuresArePreserved(t *testing.T) {
	a := testAuthorization(t)
	sc := &policyScope{result: a}
	source := &Source{Database: policyDatabase{snapshot: sc}, Origin: "https://example.test"}
	got, err := source.Current(t.Context(), a.Principal)
	if err != nil || got.Principal != a.Principal || len(sc.locks) != 1 || sc.locks[0] || sc.origins[0] != source.Origin {
		t.Fatalf("read %#v %v %#v", got, err, sc)
	}
	if _, err := source.Refresh(t.Context(), a); err != nil {
		t.Fatal(err)
	}
	changed := a
	changed.Profile = model.SessionProfile
	if _, err := source.Refresh(t.Context(), changed); err == nil {
		t.Fatal("changed profile accepted")
	}
	sentinel := errors.New("read failed")
	sc.err = sentinel
	if _, err := source.Refresh(t.Context(), a); !errors.Is(err, sentinel) {
		t.Fatalf("failure lost: %v", err)
	}
	if _, err := source.InScope(t.Context(), struct{}{}, a.Principal, false); err == nil {
		t.Fatal("missing transaction policy accepted")
	}
}

type workerPolicy struct {
	store.WorkerScope
	*policyScope
}
type botPolicy struct {
	store.BotScope
	*policyScope
}
type sessionPolicy struct {
	store.SessionScope
	*policyScope
}
type teamPolicy struct {
	store.TeamWriteScope
	*policyScope
}
type projectPolicy struct {
	store.ProjectDirectMemberScope
	*policyScope
}
type promptPolicy struct {
	store.PromptSnapshot
	*policyScope
}
type usagePolicy struct {
	store.UsageScope
	*policyScope
}

func TestOperationSourcesRetainTransactionAndLockMode(t *testing.T) {
	a := testAuthorization(t)
	sc := &policyScope{result: a}
	s := &Source{Origin: "https://example.test"}
	ctx := t.Context()
	p := a.Principal
	checks := []func() (model.CredentialAuthorization, error){func() (model.CredentialAuthorization, error) { return s.WorkerWrite(ctx, workerPolicy{nil, sc}, p) }, func() (model.CredentialAuthorization, error) { return s.BotWrite(ctx, botPolicy{nil, sc}, p) }, func() (model.CredentialAuthorization, error) { return s.SessionWrite(ctx, sessionPolicy{nil, sc}, p) }, func() (model.CredentialAuthorization, error) { return s.TeamWrite(ctx, teamPolicy{nil, sc}, p) }, func() (model.CredentialAuthorization, error) { return s.ProjectWrite(ctx, projectPolicy{nil, sc}, p) }, func() (model.CredentialAuthorization, error) { return s.PromptRead(ctx, promptPolicy{nil, sc}, p) }, func() (model.CredentialAuthorization, error) {
		return s.Usage(ctx, usagePolicy{nil, sc}, p, time.Now(), true)
	}}
	for i, f := range checks {
		if _, err := f(); err != nil {
			t.Fatal(err)
		}
		if sc.locks[i] != (i != 5) {
			t.Fatalf("operation %d lock=%v", i, sc.locks[i])
		}
	}
}

type identityScope struct {
	store.IdentityScope
	dao store.IdentityDAO
}

func (s identityScope) IdentityDAO() store.IdentityDAO { return s.dao }

type patDAO struct {
	store.IdentityDAO
	store.PATScopeDAO
	store.PATManagementDAO
	token model.PersonalAccessToken
	err   error
}

func (d patDAO) PATByHash(context.Context, []byte, time.Time) (model.PersonalAccessToken, error) {
	return d.token, d.err
}
func (d patDAO) ReadLockedPATScope(context.Context, string, string) (model.PersonalAccessToken, error) {
	return d.token, d.err
}
func (d patDAO) FreshPATTime(_ context.Context, now time.Time) (time.Time, error) { return now, d.err }

type familyScope struct {
	store.CredentialFamilyScope
	dao store.CredentialFamilyDAO
}

func (s familyScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.dao }

type oauthDAO struct {
	store.CredentialFamilyDAO
	store.OAuthScopeDAO
	identity store.OAuthAccessIdentity
	err      error
}

func (d oauthDAO) ScopedAccess(context.Context, []byte, []store.OAuthBinding, time.Time) (store.OAuthAccessIdentity, error) {
	return d.identity, d.err
}
func (d oauthDAO) LockScopedAccess(context.Context, model.Principal, []store.OAuthBinding, time.Time) (store.OAuthAccessIdentity, error) {
	return d.identity, d.err
}
func TestCredentialAuthenticationAndProfileLocks(t *testing.T) {
	a := testAuthorization(t)
	pat := patDAO{token: model.PersonalAccessToken{ID: a.Principal.CredentialID, UserID: a.Principal.UserID, ScopePolicy: a.Policy}}
	s := &Source{Database: policyDatabase{identity: identityScope{dao: pat}}, Origin: "https://example.test"}
	token := secret.Random("dnpat_")
	got, authority, err := s.Authenticate(t.Context(), model.PATCredential, token, s.Origin+"/mcp")
	if err != nil || authority != a.Principal.CredentialID || got.Profile != model.ScopedPATProfile {
		t.Fatalf("PAT: %#v %s %v", got, authority, err)
	}
	if _, err := s.ProfileWrite(t.Context(), identityScope{dao: pat}, a.Principal); err != nil {
		t.Fatal(err)
	}
	session := a.Principal
	session.Kind = model.SessionCredential
	if got, err := s.ProfileWrite(t.Context(), nil, session); err != nil || got.Profile != model.SessionProfile {
		t.Fatalf("session %#v %v", got, err)
	}
	s.Database = policyDatabase{identity: identityScope{}}
	if _, _, err := s.Authenticate(t.Context(), model.PATCredential, token, ""); err == nil {
		t.Fatal("missing PAT DAO accepted")
	}
	if _, err := s.ProfileWrite(t.Context(), identityScope{}, a.Principal); err == nil {
		t.Fatal("missing profile DAO accepted")
	}
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.OAuthCredential} {
		if _, _, err := s.Authenticate(t.Context(), kind, "bad", s.Origin+"/other"); err == nil {
			t.Fatal("wrong authentication profile accepted")
		}
	}
}

func TestOAuthAuthenticationAndProfilePolicy(t *testing.T) {
	a := testAuthorization(t)
	p := a.Principal
	p.Kind = model.OAuthCredential
	policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	dao := oauthDAO{identity: store.OAuthAccessIdentity{Principal: p, GrantID: "00000000-0000-4000-8000-000000000003", ExpiresAt: time.Now().Add(time.Hour), ScopePolicy: &policy}}
	s := &Source{Database: policyDatabase{family: familyScope{dao: dao}}, Origin: "https://example.test"}
	got, id, err := s.Authenticate(t.Context(), model.OAuthCredential, secret.Random(model.OAuthAccessPrefix), s.Origin+"/mcp")
	if err != nil || got.Profile != model.ScopedMCPProfile || id != dao.identity.GrantID {
		t.Fatalf("OAuth %#v %s %v", got, id, err)
	}
	dao.identity.ScopePolicy = nil
	sc := profileFamily{identityScope: identityScope{}, family: dao}
	got, err = s.ProfileWrite(t.Context(), sc, p)
	if err != nil || got.Profile != model.OAuthAPIProfile {
		t.Fatalf("API lock %#v %v", got, err)
	}
	if _, err := s.ProfileWrite(t.Context(), profileFamily{}, p); err == nil {
		t.Fatal("missing OAuth policy capability accepted")
	}
	s.Database = policyDatabase{family: familyScope{}}
	if _, _, err := s.Authenticate(t.Context(), model.OAuthCredential, "bad", s.Origin+"/mcp"); err == nil {
		t.Fatal("missing OAuth auth capability accepted")
	}
}

type profileFamily struct {
	identityScope
	family store.CredentialFamilyDAO
}

func (s profileFamily) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.family }
func TestBoundSourceRejectsChangedActorAndInvalidPolicy(t *testing.T) {
	a := testAuthorization(t)
	sc := &policyScope{result: a}
	s := &Source{Database: policyDatabase{snapshot: sc}}
	other := a.Principal
	other.UserID = "00000000-0000-4000-8000-000000000009"
	if _, err := s.Current(t.Context(), other); err == nil {
		t.Fatal("changed actor accepted")
	}
	sc.result.Policy = nil
	if _, err := s.Current(t.Context(), a.Principal); err == nil {
		t.Fatal("absent scoped policy accepted")
	}
}
