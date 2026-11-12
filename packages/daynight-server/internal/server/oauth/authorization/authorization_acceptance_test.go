package authorization

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"reflect"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type httpTestStore struct {
	t                         *testing.T
	WriteIdentityCall         func(context.Context, func(store.IdentityScope) error) (store.Completion, error)
	WriteAuthorizationsCall   func(context.Context, func(store.AuthorizationScope) error) (store.Completion, error)
	WriteCredentialFamilyCall func(context.Context, func(store.CredentialFamilyScope) error) (store.Completion, error)
}

func newHTTPTestStore(t *testing.T) *httpTestStore { return &httpTestStore{t: t} }
func (s *httpTestStore) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	if s.WriteIdentityCall == nil {
		unexpectedHTTPCall(s.t, "WriteIdentity")
	}
	return s.WriteIdentityCall(ctx, fn)
}
func (s *httpTestStore) WriteAuthorizations(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
	if s.WriteAuthorizationsCall == nil {
		unexpectedHTTPCall(s.t, "WriteAuthorizations")
	}
	return s.WriteAuthorizationsCall(ctx, fn)
}
func (s *httpTestStore) WriteCredentialFamily(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error) {
	if s.WriteCredentialFamilyCall == nil {
		unexpectedHTTPCall(s.t, "WriteCredentialFamily")
	}
	return s.WriteCredentialFamilyCall(ctx, fn)
}
func (s *httpTestStore) WriteOAuthClients(context.Context, func(store.OAuthClientScope) error) (store.Completion, error) {
	unexpectedHTTPCall(s.t, "WriteOAuthClients")
	panic("unreachable")
}

type httpAuthenticationScope struct {
	t   *testing.T
	dao store.IdentityDAO
}

func (s httpAuthenticationScope) IdentityDAO() store.IdentityDAO { return s.dao }
func (s httpAuthenticationScope) PersonalTeamDAO() store.PersonalTeamDAO {
	unexpectedHTTPCall(s.t, "PersonalTeamDAO")
	return nil
}
func unexpectedHTTPCall(t *testing.T, name string) {
	t.Helper()
	t.Errorf("unconfigured or extra DAO call: %s", name)
	panic("unconfigured or extra DAO call: " + name)
}
func httpTestToken(kind model.CredentialKind) string {
	if kind != model.SessionCredential {
		panic("unexpected credential kind")
	}
	return "dnst_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}
func bytesEqualOAuthHash(token string, hash []byte) bool {
	return bytes.Equal(secret.Hash(token), hash)
}
func await[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case result := <-channel:
		return result
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for operation")
		var zero T
		return zero
	}
}

type httpRejectedIdentityDAO struct{ t *testing.T }

func (d httpRejectedIdentityDAO) Authenticate(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.Authenticate")
	panic("unreachable")
}

func (d httpRejectedIdentityDAO) CleanupCredentials(context.Context, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.CleanupCredentials")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) CleanupLoginCredentials(context.Context, time.Time, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.CleanupLoginCredentials")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) AdmitLogin(context.Context, []byte, int, int) (time.Time, string, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.AdmitLogin")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) InsertLogin(context.Context, model.LoginTransaction) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertLogin")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) ConsumeLogin(context.Context, []byte, []byte, time.Time) (model.LoginTransaction, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.ConsumeLogin")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) UpsertUser(context.Context, model.User, time.Time) (model.User, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.UpsertUser")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) InsertSession(context.Context, model.Session) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertSession")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) IdentityUser(context.Context, string) (model.User, store.PersonalTeamFacts, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.IdentityUser")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) IdentityPersonalTeam(context.Context, string) (store.PersonalTeamFacts, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.IdentityPersonalTeam")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) DeleteSession(context.Context, model.Principal) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.DeleteSession")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) LockSession(context.Context, model.Principal, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockSession")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) InsertPAT(context.Context, model.PersonalAccessToken) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertPAT")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) ListPATs(context.Context, string, time.Time) ([]model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.ListPATs")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) DeletePAT(context.Context, string, string) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.DeletePAT")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) LockActivePAT(context.Context, string, string, time.Time) (model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockActivePAT")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) SetPATExpiry(context.Context, string, *time.Time) (model.PersonalAccessToken, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.SetPATExpiry")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) PruneDeviceRates(context.Context, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.PruneDeviceRates")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) IncrementDeviceRate(context.Context, model.DeviceRateBucket, time.Time) (int, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.IncrementDeviceRate")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) PruneDevices(context.Context, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.PruneDevices")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) InsertDevice(context.Context, model.DeviceAuthorization) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.InsertDevice")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) DeviceByUserCode(context.Context, string, string, bool) (model.DeviceAuthorization, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.DeviceByUserCode")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) LockDeviceByHash(context.Context, []byte) (model.DeviceAuthorization, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockDeviceByHash")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) SetDeviceDecision(context.Context, string, string, string) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.SetDeviceDecision")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) DelayDevicePoll(context.Context, string, time.Time, bool) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.DelayDevicePoll")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) ConsumeDevice(context.Context, string) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.ConsumeDevice")
	panic("unreachable")
}

type httpCallPlan struct {
	t          *testing.T
	mu         sync.Mutex
	want, seen map[string]int
}

func newHTTPCallPlan(t *testing.T, want map[string]int) *httpCallPlan {
	t.Helper()
	p := &httpCallPlan{t: t, want: make(map[string]int, len(want)), seen: make(map[string]int)}
	for name, count := range want {
		p.want[name] = count
	}
	t.Cleanup(p.Verify)
	return p
}
func (p *httpCallPlan) Called(name string) {
	p.mu.Lock()
	p.seen[name]++
	got, want := p.seen[name], p.want[name]
	p.mu.Unlock()
	if got > want {
		unexpectedHTTPCall(p.t, name)
	}
}
func (p *httpCallPlan) Verify() {
	p.t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	for name, want := range p.want {
		if p.seen[name] != want {
			p.t.Errorf("DAO %s calls = %d, want %d", name, p.seen[name], want)
		}
	}
}

type oauthHTTPFixture struct {
	Store                 *httpTestStore
	Auth                  *authhttp.Authentication
	Principal, Other      model.Principal
	Session, OtherSession *http.Cookie
	Origin                string
	Now                   time.Time
	mu                    sync.Mutex
	Rates                 map[string]int
}

func newOAuthHTTPFixture(t *testing.T) *oauthHTTPFixture {
	t.Helper()
	f := &oauthHTTPFixture{Store: newHTTPTestStore(t), Origin: "http://127.0.0.1:8787", Now: time.Now().UTC().Truncate(time.Microsecond), Rates: make(map[string]int)}
	f.Principal = model.Principal{Kind: model.SessionCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222"}
	f.Other = model.Principal{Kind: model.SessionCredential, UserID: "c3333333-3333-4333-8333-333333333333", CredentialID: "d4444444-4444-4444-8444-444444444444"}
	identity := identityservice.New(f.Store, nil, f.Origin+"/api/v1/auth/callback")
	var err error
	f.Auth, err = authhttp.NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: f.Origin, AllowHTTPTestOrigin: true}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	f.Session = &http.Cookie{Name: f.Auth.SessionCookieName(), Value: httpTestToken(model.SessionCredential)}
	f.OtherSession = &http.Cookie{Name: f.Auth.SessionCookieName(), Value: "dnst_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"}
	f.Store.WriteIdentityCall = func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
		dao := &oauthHTTPIdentityDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, fixture: f}
		err := fn(httpAuthenticationScope{t: t, dao: dao})
		if dao.authenticate != 1 && (dao.prune != 1 || dao.increment < 1 || dao.increment > 2) {
			t.Errorf("identity callback calls: authenticate=%d prune=%d increment=%d", dao.authenticate, dao.prune, dao.increment)
		}
		return oauthHTTPResult(t, store.TransactionCommitted, err, false)
	}
	return f
}

// Callback errors and transaction outcomes are independently supplied test facts.
func oauthHTTPResult(t *testing.T, outcome store.TransactionOutcome, err error, wantError bool) (store.Completion, error) {
	t.Helper()
	if (err != nil) != wantError {
		t.Errorf("OAuth callback error = %v, want error %t", err, wantError)
	}
	return store.Completion{Outcome: outcome}, err
}

type oauthHTTPIdentityDAO struct {
	httpRejectedIdentityDAO
	fixture                        *oauthHTTPFixture
	authenticate, prune, increment int
}

func (d *oauthHTTPIdentityDAO) Authenticate(_ context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	d.authenticate++
	if d.authenticate != 1 || d.prune != 0 || kind != model.SessionCredential || now.IsZero() || now.Location() != time.UTC {
		unexpectedHTTPCall(d.t, "OAuth Authenticate arguments/order")
	}
	switch {
	case bytes.Equal(hash, secret.Hash(d.fixture.Session.Value)):
		return d.fixture.Principal, nil
	case bytes.Equal(hash, secret.Hash(d.fixture.OtherSession.Value)):
		return d.fixture.Other, nil
	default:
		unexpectedHTTPCall(d.t, "OAuth Authenticate credential")
		return model.Principal{}, model.ErrNotFound
	}
}
func (d *oauthHTTPIdentityDAO) PruneDeviceRates(_ context.Context, now time.Time) error {
	d.prune++
	if d.prune != 1 || d.authenticate != 0 || d.increment != 0 || now.IsZero() || now.Location() != time.UTC {
		unexpectedHTTPCall(d.t, "OAuth PruneDeviceRates arguments/order")
	}
	return nil
}
func (d *oauthHTTPIdentityDAO) IncrementDeviceRate(_ context.Context, bucket model.DeviceRateBucket, now time.Time) (int, error) {
	d.increment++
	if d.prune != 1 || now.IsZero() || now.Location() != time.UTC {
		unexpectedHTTPCall(d.t, "OAuth IncrementDeviceRate arguments/order")
	}
	key := ""
	for kind, limits := range map[string][2]int{"start": {300, 30}} {
		for candidate, limit := range map[string]int{"oauth:" + kind + ":global": limits[0], "oauth:" + kind + ":source:127.0.0.1": limits[1]} {
			if bytes.Equal(bucket.Hash, secret.Hash(candidate)) && bucket.Limit == limit {
				key = candidate
			}
		}
	}
	if key == "" {
		unexpectedHTTPCall(d.t, "OAuth rate bucket")
	}
	d.fixture.mu.Lock()
	d.fixture.Rates[key]++
	d.fixture.mu.Unlock()
	return 1, nil
}

type oauthHTTPAuthorizationDAO struct {
	store.AuthorizationDAO
	t      *testing.T
	plan   *httpCallPlan
	insert func(context.Context, store.OAuthAuthorization, int, time.Time) (bool, error)
	read   func(context.Context, string, bool) (store.OAuthAuthorization, error)
	code   func(context.Context, []byte, bool) (store.OAuthAuthorization, error)
	update func(context.Context, store.OAuthAuthorization) error
	now    time.Time
}

func (d *oauthHTTPAuthorizationDAO) InsertAuthorization(ctx context.Context, a store.OAuthAuthorization, capacity int, now time.Time) (bool, error) {
	d.plan.Called("insert")
	if d.insert == nil {
		unexpectedHTTPCall(d.t, "Authorization.Insert")
	}
	return d.insert(ctx, a, capacity, now)
}
func (d *oauthHTTPAuthorizationDAO) Authorization(ctx context.Context, id string, lock bool) (store.OAuthAuthorization, error) {
	d.plan.Called("read")
	if d.read == nil {
		unexpectedHTTPCall(d.t, "Authorization.Read")
	}
	a, e := d.read(ctx, id, lock)
	return oauthHTTPCloneAuthorization(a), e
}
func (d *oauthHTTPAuthorizationDAO) AuthorizationByCode(ctx context.Context, hash []byte, lock bool) (store.OAuthAuthorization, error) {
	d.plan.Called("code")
	if d.code == nil {
		unexpectedHTTPCall(d.t, "Authorization.Code")
	}
	a, e := d.code(ctx, hash, lock)
	return oauthHTTPCloneAuthorization(a), e
}
func (d *oauthHTTPAuthorizationDAO) UpdateAuthorization(ctx context.Context, a store.OAuthAuthorization) error {
	d.plan.Called("update")
	if d.update == nil {
		unexpectedHTTPCall(d.t, "Authorization.Update")
	}
	return d.update(ctx, a)
}
func (d *oauthHTTPAuthorizationDAO) FreshTime(_ context.Context, now time.Time) (time.Time, error) {
	d.plan.Called("time")
	if now.IsZero() || now.Location() != time.UTC {
		unexpectedHTTPCall(d.t, "Authorization.FreshTime")
	}
	return d.now, nil
}

type oauthHTTPFamilyDAO struct {
	store.CredentialFamilyDAO
	t            *testing.T
	plan         *httpCallPlan
	issue        func(store.OAuthFamilyIssue) error
	inspect      func(string, bool) (store.OAuthGrant, error)
	revoke       func(string, time.Time) (bool, error)
	authenticate func([]byte, string, string, time.Time) (store.OAuthAccessIdentity, error)
}

func (d *oauthHTTPFamilyDAO) IssueFamily(_ context.Context, in store.OAuthFamilyIssue) error {
	d.plan.Called("issue")
	if d.issue == nil {
		unexpectedHTTPCall(d.t, "Family.Issue")
	}
	return d.issue(in)
}
func (d *oauthHTTPFamilyDAO) InspectGrant(_ context.Context, id string, lock bool) (store.OAuthGrant, error) {
	d.plan.Called("grant")
	if d.inspect == nil {
		unexpectedHTTPCall(d.t, "Family.Inspect")
	}
	g, e := d.inspect(id, lock)
	return oauthHTTPCloneGrant(g), e
}
func (d *oauthHTTPFamilyDAO) RevokeFamily(_ context.Context, id string, now time.Time) (bool, error) {
	d.plan.Called("revoke")
	if d.revoke == nil {
		unexpectedHTTPCall(d.t, "Family.Revoke")
	}
	return d.revoke(id, now)
}
func (d *oauthHTTPFamilyDAO) AuthenticateAccess(_ context.Context, hash []byte, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	d.plan.Called("authenticate")
	if d.authenticate == nil {
		unexpectedHTTPCall(d.t, "Family.Authenticate")
	}
	if len(bindings) != 1 || bindings[0].ClientID != "" {
		d.t.Fatalf("unexpected OAuth bindings: %+v", bindings)
	}
	return d.authenticate(hash, bindings[0].Resource, bindings[0].Scope, now)
}

type oauthHTTPAuthorizationScope struct {
	store.AuthorizationScope
	identities     store.IdentityDAO
	authorizations store.AuthorizationDAO
	families       store.CredentialFamilyDAO
	clients        store.OAuthClientDAO
}

func (s oauthHTTPAuthorizationScope) IdentityDAO() store.IdentityDAO { return s.identities }
func (s oauthHTTPAuthorizationScope) AuthorizationDAO() store.AuthorizationDAO {
	return s.authorizations
}
func (s oauthHTTPAuthorizationScope) CredentialFamilyDAO() store.CredentialFamilyDAO {
	return s.families
}
func (s oauthHTTPAuthorizationScope) OAuthClientDAO() store.OAuthClientDAO { return s.clients }

type oauthHTTPFamilyScope struct{ families store.CredentialFamilyDAO }

func (s oauthHTTPFamilyScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.families }

func oauthHTTPPlan(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, lock bool, want map[string]int, update func(store.OAuthAuthorization) error, outcome store.TransactionOutcome, wantError bool) *oauthHTTPAuthorizationDAO {
	t.Helper()
	plan := newHTTPCallPlan(t, want)
	dao := &oauthHTTPAuthorizationDAO{t: t, plan: plan, now: f.Now, update: func(_ context.Context, a store.OAuthAuthorization) error { return update(a) }}
	dao.read = func(_ context.Context, id string, actualLock bool) (store.OAuthAuthorization, error) {
		if id != row.ID || actualLock != lock {
			unexpectedHTTPCall(t, "Authorization.Read arguments")
		}
		return row, nil
	}
	f.Store.WriteAuthorizationsCall = func(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
		plan.Called("transaction")
		err := fn(oauthHTTPAuthorizationScope{identities: &oauthHTTPLockedIdentityDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, fixture: f, plan: plan}, authorizations: dao})
		return oauthHTTPResult(t, outcome, err, wantError)
	}
	return dao
}

type oauthHTTPLockedIdentityDAO struct {
	httpRejectedIdentityDAO
	fixture *oauthHTTPFixture
	plan    *httpCallPlan
}

func (d *oauthHTTPLockedIdentityDAO) LockSession(_ context.Context, p model.Principal, now time.Time) error {
	d.plan.Called("session")
	if (p != d.fixture.Principal && p != d.fixture.Other) || now.IsZero() || now.Location() != time.UTC {
		unexpectedHTTPCall(d.t, "Authorization session arguments")
	}
	return nil
}

func oauthHTTPPending(f *oauthHTTPFixture, id, binding, state, clientID, redirect, provenance string) store.OAuthAuthorization {
	challenge := sha256.Sum256([]byte("vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv"))
	client := oauthHTTPClientFacts(f, clientID, redirect)
	if client.Provenance != provenance {
		unexpectedHTTPCall(f.Store.t, "OAuth fixture client provenance")
	}
	raw, _ := json.Marshal(client)
	return store.OAuthAuthorization{ID: id, BindingHash: secret.Hash(binding), Client: raw, ClientID: clientID, RedirectURI: redirect, Resource: f.Origin + "/mcp", Scope: core.Scope, Challenge: base64.RawURLEncoding.EncodeToString(challenge[:]), State: state, StatePresent: true, Status: "pending", CreatedAt: f.Now, ExpiresAt: f.Now.Add(10 * time.Minute), RetainUntil: f.Now.Add(10*time.Minute + 24*time.Hour)}
}

func oauthHTTPApproved(f *oauthHTTPFixture, pending store.OAuthAuthorization, code string) store.OAuthAuthorization {
	a := pending
	a.Status = "approved"
	a.UserID = f.Principal.UserID
	a.CodeHash = secret.Hash(code)
	expires := f.Now.Add(5 * time.Minute)
	a.CodeExpiresAt = &expires
	a.State = ""
	a.StatePresent = false
	a.RetainUntil = f.Now.Add(24 * time.Hour)
	return a
}

func oauthHTTPRead(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization) {
	oauthHTTPPlan(t, f, row, false, map[string]int{"transaction": 1, "session": 2, "read": 1, "time": 1}, nil, store.TransactionCommitted, false)
}

func oauthHTTPDecision(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, status string) *atomic.Pointer[store.OAuthAuthorization] {
	captured := new(atomic.Pointer[store.OAuthAuthorization])
	want := map[string]int{"transaction": 1, "session": 2, "read": 1, "time": 1}
	outcome, wantError := store.TransactionNotCommitted, true
	if row.Status == "pending" {
		want["update"] = 1
		outcome, wantError = store.TransactionCommitted, false
	}
	oauthHTTPPlan(t, f, row, true, want, func(a store.OAuthAuthorization) error {
		expected := row
		expected.Status = status
		expected.State = ""
		expected.StatePresent = false
		expected.UserID = f.Principal.UserID
		expected.RetainUntil = f.Now.Add(24 * time.Hour)
		if status == "approved" {
			expected.CodeHash = a.CodeHash
			expires := f.Now.Add(5 * time.Minute)
			expected.CodeExpiresAt = &expires
			if len(a.CodeHash) != sha256.Size {
				unexpectedHTTPCall(t, "Authorization approval secret/expiry")
			}
		}
		if !reflect.DeepEqual(a, expected) {
			t.Errorf("authorization update differs: %+v / %+v", a, expected)
		}
		copy := oauthHTTPCloneAuthorization(a)
		captured.Store(&copy)
		return nil
	}, outcome, wantError)
	return captured
}

func oauthHTTPExpectAccess(t *testing.T, f *oauthHTTPFixture, token, resource string, p model.Principal, grant string, err error) {
	plan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "authenticate": 1})
	dao := &oauthHTTPFamilyDAO{t: t, plan: plan, authenticate: func(hash []byte, actualResource, scope string, now time.Time) (store.OAuthAccessIdentity, error) {
		if !bytes.Equal(hash, secret.Hash(token)) || actualResource != resource || scope != core.Scope || now.IsZero() {
			unexpectedHTTPCall(t, "OAuth access arguments")
		}
		return store.OAuthAccessIdentity{Principal: p, GrantID: grant, ExpiresAt: now.Add(time.Hour)}, err
	}}
	f.Store.WriteCredentialFamilyCall = func(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error) {
		plan.Called("transaction")
		e := fn(oauthHTTPFamilyScope{families: dao})
		return oauthHTTPResult(t, store.TransactionNotCommitted, e, true)
	}
}

func oauthHTTPExpectStart(t *testing.T, f *oauthHTTPFixture, clientID, redirect, state string) *atomic.Pointer[store.OAuthAuthorization] {
	captured := new(atomic.Pointer[store.OAuthAuthorization])
	digest := sha256.Sum256([]byte("vvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvvv"))
	expectedChallenge := base64.RawURLEncoding.EncodeToString(digest[:])
	plan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "insert": 1})
	dao := &oauthHTTPAuthorizationDAO{t: t, plan: plan, insert: func(_ context.Context, a store.OAuthAuthorization, capacity int, now time.Time) (bool, error) {
		if _, err := uuid.Parse(a.ID); err != nil || len(a.BindingHash) != sha256.Size || a.ClientID != clientID || a.RedirectURI != redirect || a.Resource != f.Origin+"/mcp" || a.Scope != core.Scope || a.State != state || a.StatePresent != (state != "") || a.Status != "pending" || a.UserID != "" || a.GrantID != "" || len(a.CodeHash) != 0 || a.CodeExpiresAt != nil || capacity != 10000 || !a.CreatedAt.Equal(now) || a.ExpiresAt.Sub(now) != 10*time.Minute || a.RetainUntil.Sub(now) != 10*time.Minute+24*time.Hour {
			t.Errorf("authorization insertion arguments: %+v capacity=%d now=%v", a, capacity, now)
		}
		var client core.ValidatedClient
		if json.Unmarshal(a.Client, &client) != nil || !reflect.DeepEqual(client, oauthHTTPClientFacts(f, clientID, redirect)) || a.Challenge != expectedChallenge {
			t.Errorf("authorization frozen client/challenge: %s/%q", a.Client, a.Challenge)
		}
		copy := oauthHTTPCloneAuthorization(a)
		captured.Store(&copy)
		return true, nil
	}}
	f.Store.WriteAuthorizationsCall = func(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
		plan.Called("transaction")
		err := fn(oauthHTTPAuthorizationScope{authorizations: dao})
		return oauthHTTPResult(t, store.TransactionCommitted, err, false)
	}
	return captured
}

func oauthHTTPExpectRedeem(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, refused bool, issued *store.OAuthFamilyIssue) {
	want := map[string]int{"transaction": 1, "code": 2, "time": 1}
	locks := []bool{false, true}
	outcome := store.TransactionNotCommitted
	if !refused {
		want["issue"] = 1
		want["update"] = 1
		outcome = store.TransactionCommitted
	}
	plan := newHTTPCallPlan(t, want)
	codeCalls := 0
	family := &oauthHTTPFamilyDAO{t: t, plan: plan, issue: func(in store.OAuthFamilyIssue) error {
		expectedGrant := store.OAuthGrant{ID: in.Grant.ID, UserID: row.UserID, ClientID: row.ClientID, Resource: row.Resource, Scope: core.Scope, ClientSnapshot: row.Client, CreatedAt: f.Now, ExpiresAt: f.Now.Add(core.GrantLifetime)}
		if _, e := uuid.Parse(in.Grant.ID); e != nil {
			t.Error(e)
		}
		if _, e := uuid.Parse(in.AccessID); e != nil {
			t.Error(e)
		}
		if !reflect.DeepEqual(in.Grant, expectedGrant) || len(in.AccessHash) != sha256.Size || len(in.RefreshHash) != sha256.Size || !in.AccessExpiresAt.Equal(f.Now.Add(core.AccessLifetime)) {
			t.Errorf("family issue arguments: %+v", in)
		}
		*issued = oauthHTTPCloneIssue(in)
		return nil
	}}
	dao := &oauthHTTPAuthorizationDAO{t: t, plan: plan, now: f.Now, code: func(_ context.Context, hash []byte, lock bool) (store.OAuthAuthorization, error) {
		if codeCalls >= len(locks) || lock != locks[codeCalls] || !bytes.Equal(hash, row.CodeHash) {
			unexpectedHTTPCall(t, "redemption code arguments/order")
		}
		codeCalls++
		return row, nil
	}, update: func(_ context.Context, a store.OAuthAuthorization) error {
		expected := row
		expected.Status = "consumed"
		expected.GrantID = issued.Grant.ID
		expected.RetainUntil = f.Now.Add(core.GrantLifetime)
		if !reflect.DeepEqual(a, expected) {
			t.Errorf("consumed authorization arguments: %+v / %+v", a, expected)
		}
		return nil
	}}
	f.Store.WriteAuthorizationsCall = func(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
		plan.Called("transaction")
		err := fn(oauthHTTPAuthorizationScope{authorizations: dao, families: family})
		return oauthHTTPResult(t, outcome, err, refused)
	}
}

func oauthHTTPConcurrentRedeem(t *testing.T, f *oauthHTTPFixture, approved store.OAuthAuthorization, issued *store.OAuthFamilyIssue) {
	var transactions atomic.Int32
	committed := make(chan struct{})
	f.Store.WriteAuthorizationsCall = func(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
		ordinal := transactions.Add(1)
		if ordinal > 2 {
			unexpectedHTTPCall(t, "concurrent redemption transaction")
		}
		row := approved
		if ordinal == 2 {
			select {
			case <-committed:
			case <-ctx.Done():
				return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
			}
			row.Status = "consumed"
			row.GrantID = issued.Grant.ID
			row.RetainUntil = f.Now.Add(core.GrantLifetime)
		}
		want := map[string]int{"transaction": 1, "code": 2, "time": 1}
		if ordinal == 1 {
			want["issue"] = 1
			want["update"] = 1
		} else {
			want["grant"] = 2
			want["revoke"] = 1
		}
		plan := newHTTPCallPlan(t, want)
		plan.Called("transaction")
		reads, grantReads := 0, 0
		family := &oauthHTTPFamilyDAO{t: t, plan: plan, issue: func(in store.OAuthFamilyIssue) error {
			expected := store.OAuthGrant{ID: in.Grant.ID, UserID: f.Principal.UserID, ClientID: approved.ClientID, Resource: approved.Resource, Scope: core.Scope, ClientSnapshot: approved.Client, CreatedAt: f.Now, ExpiresAt: f.Now.Add(core.GrantLifetime)}
			if !reflect.DeepEqual(in.Grant, expected) || len(in.AccessHash) != sha256.Size || len(in.RefreshHash) != sha256.Size || !in.AccessExpiresAt.Equal(f.Now.Add(core.AccessLifetime)) {
				t.Errorf("concurrent issue arguments: %+v", in)
			}
			*issued = oauthHTTPCloneIssue(in)
			return nil
		}, inspect: func(id string, lock bool) (store.OAuthGrant, error) {
			if id != issued.Grant.ID || lock != (grantReads == 0) {
				unexpectedHTTPCall(t, "concurrent redemption grant arguments/order")
			}
			grantReads++
			return issued.Grant, nil
		}, revoke: func(id string, now time.Time) (bool, error) {
			if id != issued.Grant.ID || !now.Equal(f.Now) {
				unexpectedHTTPCall(t, "concurrent replay revocation")
			}
			return true, nil
		}}
		dao := &oauthHTTPAuthorizationDAO{t: t, plan: plan, now: f.Now, code: func(_ context.Context, hash []byte, lock bool) (store.OAuthAuthorization, error) {
			if !bytes.Equal(hash, approved.CodeHash) || lock != (reads == 1) {
				unexpectedHTTPCall(t, "concurrent code arguments/order")
			}
			reads++
			return row, nil
		}, update: func(_ context.Context, a store.OAuthAuthorization) error {
			expected := approved
			expected.Status = "consumed"
			expected.GrantID = issued.Grant.ID
			expected.RetainUntil = f.Now.Add(core.GrantLifetime)
			if !reflect.DeepEqual(a, expected) {
				t.Errorf("concurrent consumed row: %+v", a)
			}
			return nil
		}}
		err := fn(oauthHTTPAuthorizationScope{authorizations: dao, families: family})
		if ordinal == 1 {
			close(committed)
		}
		return oauthHTTPResult(t, store.TransactionCommitted, err, false)
	}
	t.Cleanup(func() {
		if transactions.Load() != 2 {
			t.Errorf("concurrent redemption transactions=%d", transactions.Load())
		}
	})
}

func oauthHTTPClonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func oauthHTTPCloneAuthorization(a store.OAuthAuthorization) store.OAuthAuthorization {
	a.BindingHash = bytes.Clone(a.BindingHash)
	a.Client = bytes.Clone(a.Client)
	a.CodeHash = bytes.Clone(a.CodeHash)
	a.CodeExpiresAt = oauthHTTPClonePointer(a.CodeExpiresAt)
	return a
}
func oauthHTTPCloneGrant(g store.OAuthGrant) store.OAuthGrant {
	g.ClientSnapshot = bytes.Clone(g.ClientSnapshot)
	g.RevokedAt = oauthHTTPClonePointer(g.RevokedAt)
	return g
}
func oauthHTTPCloneIssue(i store.OAuthFamilyIssue) store.OAuthFamilyIssue {
	i.Grant = oauthHTTPCloneGrant(i.Grant)
	i.AccessHash = bytes.Clone(i.AccessHash)
	i.RefreshHash = bytes.Clone(i.RefreshHash)
	return i
}
func oauthHTTPClientFacts(f *oauthHTTPFixture, clientID, redirect string) core.ValidatedClient {
	if clientID != "acceptance-client" {
		unexpectedHTTPCall(f.Store.t, "OAuth fixture client configuration")
	}
	redirects := []string{redirect}
	metadata := core.ClientMetadata{ClientID: clientID, ClientName: "Acceptance", RedirectURIs: redirects, TokenEndpointAuthMethod: "none"}
	canonical, err := json.Marshal(metadata)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(canonical)
	return core.ValidatedClient{ClientID: clientID, Provenance: "preregistered", ClientName: "Acceptance", MetadataDigest: hex.EncodeToString(digest[:]), Redirects: slices.Clone(redirects), SelectedExactRedirect: redirect}
}
