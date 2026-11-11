package server

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

	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type oauthHTTPFixture struct {
	Store                 *httpTestStore
	Auth                  *authhttp.Authentication
	Principal, Other      model.Principal
	Session, OtherSession *http.Cookie
	Origin                string
	Now                   time.Time
	mu                    sync.Mutex
	Rates                 map[string]int
	ClientBudgetID        string
	PersonalTeamID        string
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
		if dao.authenticate != 1 && dao.personalTeam != 1 && (dao.prune != 1 || dao.increment < 1 || dao.increment > 2) {
			t.Errorf("identity callback calls: authenticate=%d prune=%d increment=%d", dao.authenticate, dao.prune, dao.increment)
		}
		return oauthHTTPCompletion(err), err
	}
	return f
}

func oauthHTTPCompletion(err error) store.Completion {
	if err != nil {
		return store.Completion{Outcome: store.TransactionNotCommitted}
	}
	return store.Completion{Outcome: store.TransactionCommitted}
}

type oauthHTTPIdentityDAO struct {
	httpRejectedIdentityDAO
	fixture                                      *oauthHTTPFixture
	authenticate, prune, increment, personalTeam int
}

func (d *oauthHTTPIdentityDAO) IdentityPersonalTeam(_ context.Context, user string) (store.PersonalTeamFacts, error) {
	d.personalTeam++
	if d.personalTeam != 1 || d.authenticate != 0 || d.prune != 0 || user != d.fixture.Principal.UserID || d.fixture.PersonalTeamID == "" {
		unexpectedHTTPCall(d.t, "OAuth Personal Team arguments")
	}
	return store.PersonalTeamFacts{ID: d.fixture.PersonalTeamID, MemberCount: 1, OwnerAdminCount: 1}, nil
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
	for kind, limits := range map[string][2]int{"start": {300, 30}, "register": {100, 10}, "token": {1200, 120}} {
		for candidate, limit := range map[string]int{"oauth:" + kind + ":global": limits[0], "oauth:" + kind + ":source:127.0.0.1": limits[1], "oauth:" + kind + ":source:fixture": limits[1]} {
			if bytes.Equal(bucket.Hash, secret.Hash(candidate)) && bucket.Limit == limit {
				key = candidate
			}
		}
	}
	if bytes.Equal(bucket.Hash, secret.Hash("oauth:token:client:acceptance-client")) && bucket.Limit == 240 {
		key = "oauth:token:client:acceptance-client"
	}
	if bytes.Equal(bucket.Hash, secret.Hash("oauth:token:client:known")) && bucket.Limit == 240 {
		key = "oauth:token:client:known"
	}
	if d.fixture.ClientBudgetID != "" && bytes.Equal(bucket.Hash, secret.Hash("oauth:token:client:"+d.fixture.ClientBudgetID)) && bucket.Limit == 240 {
		key = "oauth:token:client:" + d.fixture.ClientBudgetID
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
func (d *oauthHTTPFamilyDAO) AuthenticateAccess(_ context.Context, hash []byte, id, resource string, now time.Time) (store.OAuthAccessIdentity, error) {
	d.plan.Called("authenticate")
	if d.authenticate == nil {
		unexpectedHTTPCall(d.t, "Family.Authenticate")
	}
	return d.authenticate(hash, id, resource, now)
}

type oauthHTTPClientDAO struct {
	store.OAuthClientDAO
	t      *testing.T
	plan   *httpCallPlan
	insert func(store.OAuthClient, int, time.Time) (bool, error)
	read   func(string, bool) (store.OAuthClient, error)
	pin    func(string, time.Time) (store.OAuthClient, error)
}

func (d *oauthHTTPClientDAO) InsertClient(_ context.Context, in store.OAuthClient, capacity int, now time.Time) (bool, error) {
	d.plan.Called("client_insert")
	if d.insert == nil {
		unexpectedHTTPCall(d.t, "Client.Insert")
	}
	return d.insert(in, capacity, now)
}
func (d *oauthHTTPClientDAO) Client(_ context.Context, id string, lock bool) (store.OAuthClient, error) {
	d.plan.Called("client_read")
	if d.read == nil {
		unexpectedHTTPCall(d.t, "Client.Read")
	}
	c, e := d.read(id, lock)
	return oauthHTTPCloneClient(c), e
}
func (d *oauthHTTPClientDAO) PinClient(_ context.Context, id string, now time.Time) (store.OAuthClient, error) {
	d.plan.Called("client_pin")
	if d.pin == nil {
		unexpectedHTTPCall(d.t, "Client.Pin")
	}
	c, e := d.pin(id, now)
	return oauthHTTPCloneClient(c), e
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

type oauthHTTPClientScope struct {
	store.OAuthClientScope
	clients store.OAuthClientDAO
}

func (s oauthHTTPClientScope) OAuthClientDAO() store.OAuthClientDAO { return s.clients }

func oauthHTTPPlan(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, lock bool, want map[string]int, update func(store.OAuthAuthorization) error, family *oauthHTTPFamilyDAO, client *oauthHTTPClientDAO) *oauthHTTPAuthorizationDAO {
	t.Helper()
	plan := newHTTPCallPlan(t, want)
	dao := &oauthHTTPAuthorizationDAO{t: t, plan: plan, now: f.Now, update: func(_ context.Context, a store.OAuthAuthorization) error { return update(a) }}
	dao.read = func(_ context.Context, id string, actualLock bool) (store.OAuthAuthorization, error) {
		if id != row.ID || actualLock != lock {
			unexpectedHTTPCall(t, "Authorization.Read arguments")
		}
		return row, nil
	}
	dao.code = func(_ context.Context, hash []byte, actualLock bool) (store.OAuthAuthorization, error) {
		if !bytes.Equal(hash, row.CodeHash) {
			unexpectedHTTPCall(t, "Authorization.Code hash")
		}
		return row, nil
	}
	f.Store.WriteAuthorizationsCall = func(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
		plan.Called("transaction")
		err := fn(oauthHTTPAuthorizationScope{identities: &oauthHTTPLockedIdentityDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, fixture: f, plan: plan}, authorizations: dao, families: family, clients: client})
		return oauthHTTPCompletion(err), err
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
	oauthHTTPPlan(t, f, row, false, map[string]int{"transaction": 1, "session": 2, "read": 1, "time": 1}, nil, nil, nil)
}

func oauthHTTPDecision(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, status string) *atomic.Pointer[store.OAuthAuthorization] {
	captured := new(atomic.Pointer[store.OAuthAuthorization])
	want := map[string]int{"transaction": 1, "session": 2, "read": 1, "time": 1}
	if row.Status == "pending" {
		want["update"] = 1
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
	}, nil, nil)
	return captured
}

func oauthHTTPExpectAccess(t *testing.T, f *oauthHTTPFixture, token, resource string, p model.Principal, grant string, err error) {
	plan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "authenticate": 1})
	dao := &oauthHTTPFamilyDAO{t: t, plan: plan, authenticate: func(hash []byte, actualResource, scope string, now time.Time) (store.OAuthAccessIdentity, error) {
		if !bytes.Equal(hash, secret.Hash(token)) || actualResource != resource || scope != core.Scope || now.IsZero() {
			unexpectedHTTPCall(t, "OAuth access arguments")
		}
		return store.OAuthAccessIdentity{Principal: p, GrantID: grant}, err
	}}
	f.Store.WriteCredentialFamilyCall = func(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error) {
		plan.Called("transaction")
		e := fn(oauthHTTPFamilyScope{families: dao})
		return oauthHTTPCompletion(e), e
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
		return oauthHTTPCompletion(err), err
	}
	return captured
}

func oauthHTTPExpectRedeem(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, budget, replay, refused bool, issued *store.OAuthFamilyIssue) {
	want := map[string]int{"transaction": 1, "code": 2, "time": 1}
	locks := []bool{false, true}
	if budget {
		want["transaction"] = 2
		want["code"] = 3
		locks = []bool{false, false, true}
	}
	if replay {
		want["grant"] = 2
		want["revoke"] = 1
	} else if !refused {
		want["issue"] = 1
		want["update"] = 1
	}
	var clientFacts core.ValidatedClient
	if json.Unmarshal(row.Client, &clientFacts) != nil {
		t.Fatal("invalid OAuth fixture client")
	}
	if !replay && !refused && clientFacts.Provenance == "dcr" {
		want["client_pin"] = 1
		want["time"] = 2
	}
	plan := newHTTPCallPlan(t, want)
	codeCalls := 0
	grant := store.OAuthGrant{ID: row.GrantID, UserID: row.UserID, ClientID: row.ClientID, Resource: row.Resource, Scope: row.Scope, ClientSnapshot: row.Client, CreatedAt: f.Now, ExpiresAt: f.Now.Add(core.GrantLifetime)}
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
	}, inspect: func(id string, lock bool) (store.OAuthGrant, error) {
		if id != row.GrantID {
			unexpectedHTTPCall(t, "redemption grant ID")
		}
		return grant, nil
	}, revoke: func(id string, now time.Time) (bool, error) {
		if id != row.GrantID || !now.Equal(f.Now) {
			unexpectedHTTPCall(t, "redemption revoke arguments")
		}
		return true, nil
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
	client := &oauthHTTPClientDAO{t: t, plan: plan, pin: func(id string, now time.Time) (store.OAuthClient, error) {
		if id != row.ClientID || !now.Equal(f.Now) {
			unexpectedHTTPCall(t, "redemption pinned client arguments")
		}
		return store.OAuthClient{ID: id, ExpiresAt: f.Now.Add(7 * 24 * time.Hour)}, nil
	}}
	f.Store.WriteAuthorizationsCall = func(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
		plan.Called("transaction")
		err := fn(oauthHTTPAuthorizationScope{authorizations: dao, families: family, clients: client})
		return oauthHTTPCompletion(err), err
	}
}

type oauthHTTPLifecycleDAO struct {
	*oauthHTTPFamilyDAO
	refresh func([]byte, bool) (store.OAuthRefresh, error)
	rotate  func(store.OAuthRotation) error
	now     time.Time
}

func (d *oauthHTTPLifecycleDAO) LockOwnerSession(context.Context, model.Principal, time.Time) error {
	unexpectedHTTPCall(d.t, "Lifecycle.LockOwnerSession")
	return nil
}
func (d *oauthHTTPLifecycleDAO) AccessGrant(context.Context, []byte) (string, error) {
	unexpectedHTTPCall(d.t, "Lifecycle.AccessGrant")
	return "", nil
}
func (d *oauthHTTPLifecycleDAO) OwnerGrants(context.Context, string) ([]store.OAuthGrant, error) {
	unexpectedHTTPCall(d.t, "Lifecycle.OwnerGrants")
	return nil, nil
}
func (d *oauthHTTPLifecycleDAO) PruneCredentials(context.Context, time.Time, int) (int, error) {
	unexpectedHTTPCall(d.t, "Lifecycle.PruneCredentials")
	return 0, nil
}
func (d *oauthHTTPLifecycleDAO) Refresh(_ context.Context, hash []byte, lock bool) (store.OAuthRefresh, error) {
	d.plan.Called("refresh")
	if d.refresh == nil {
		unexpectedHTTPCall(d.t, "Lifecycle.Refresh")
	}
	r, e := d.refresh(hash, lock)
	r.ConsumedAt = oauthHTTPClonePointer(r.ConsumedAt)
	return r, e
}
func (d *oauthHTTPLifecycleDAO) FreshTime(_ context.Context, now time.Time) (time.Time, error) {
	d.plan.Called("time")
	if now.IsZero() || now.Location() != time.UTC {
		unexpectedHTTPCall(d.t, "Lifecycle.Time")
	}
	return d.now, nil
}
func (d *oauthHTTPLifecycleDAO) RotateRefresh(_ context.Context, in store.OAuthRotation) error {
	d.plan.Called("rotate")
	if d.rotate == nil {
		unexpectedHTTPCall(d.t, "Lifecycle.Rotate")
	}
	return d.rotate(in)
}

func oauthHTTPExpectRotate(t *testing.T, f *oauthHTTPFixture, token string, grant store.OAuthGrant, replay, wrongClient bool, rotation *store.OAuthRotation) {
	want := map[string]int{"transaction": 2, "refresh": 3, "grant": 2, "time": 1}
	if wrongClient {
		want = map[string]int{"transaction": 1, "refresh": 1, "grant": 1}
	} else if replay {
		want["revoke"] = 1
	} else {
		want["rotate"] = 1
	}
	plan := newHTTPCallPlan(t, want)
	reads, grants := 0, 0
	consumed := (*time.Time)(nil)
	if replay {
		value := f.Now
		consumed = &value
	}
	family := &oauthHTTPFamilyDAO{t: t, plan: plan, inspect: func(id string, lock bool) (store.OAuthGrant, error) {
		expected := grants == 1
		grants++
		if id != grant.ID || lock != expected {
			unexpectedHTTPCall(t, "rotation grant arguments/order")
		}
		return grant, nil
	}, revoke: func(id string, now time.Time) (bool, error) {
		if id != grant.ID || !now.Equal(f.Now) {
			unexpectedHTTPCall(t, "rotation revoke arguments")
		}
		return true, nil
	}}
	dao := &oauthHTTPLifecycleDAO{oauthHTTPFamilyDAO: family, now: f.Now, refresh: func(hash []byte, lock bool) (store.OAuthRefresh, error) {
		expected := reads == 2
		reads++
		if !bytes.Equal(hash, secret.Hash(token)) || lock != expected {
			unexpectedHTTPCall(t, "rotation refresh arguments/order")
		}
		return store.OAuthRefresh{GrantID: grant.ID, ClientID: grant.ClientID, ExpiresAt: grant.ExpiresAt, ConsumedAt: consumed}, nil
	}, rotate: func(in store.OAuthRotation) error {
		if !reflect.DeepEqual(in.Grant, grant) || !bytes.Equal(in.OldHash, secret.Hash(token)) || len(in.AccessHash) != sha256.Size || len(in.RefreshHash) != sha256.Size || !in.CreatedAt.Equal(f.Now) || !in.AccessExpiresAt.Equal(f.Now.Add(core.AccessLifetime)) {
			t.Errorf("rotation arguments: %+v", in)
		}
		*rotation = oauthHTTPCloneRotation(in)
		return nil
	}}
	f.Store.WriteGrantLifecycleCall = func(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
		plan.Called("transaction")
		err := fn(dao)
		return oauthHTTPCompletion(err), err
	}
}

func oauthHTTPExpectRevoke(t *testing.T, f *oauthHTTPFixture, token string, grant store.OAuthGrant, wrongClient bool) {
	want := map[string]int{"transaction": 1, "refresh": 2, "grant": 1, "time": 1, "revoke": 1}
	if wrongClient {
		want = map[string]int{"transaction": 1, "refresh": 1, "grant": 1}
	}
	plan := newHTTPCallPlan(t, want)
	reads := 0
	family := &oauthHTTPFamilyDAO{t: t, plan: plan, inspect: func(id string, lock bool) (store.OAuthGrant, error) {
		if id != grant.ID || !lock {
			unexpectedHTTPCall(t, "public revoke grant arguments")
		}
		return grant, nil
	}, revoke: func(id string, now time.Time) (bool, error) {
		if id != grant.ID || !now.Equal(f.Now) {
			unexpectedHTTPCall(t, "public revoke arguments")
		}
		return true, nil
	}}
	dao := &oauthHTTPLifecycleDAO{oauthHTTPFamilyDAO: family, now: f.Now, refresh: func(hash []byte, lock bool) (store.OAuthRefresh, error) {
		if !bytes.Equal(hash, secret.Hash(token)) || lock != (reads == 1) {
			unexpectedHTTPCall(t, "public revoke refresh arguments/order")
		}
		reads++
		return store.OAuthRefresh{GrantID: grant.ID, ClientID: grant.ClientID, ExpiresAt: grant.ExpiresAt}, nil
	}}
	f.Store.WriteGrantLifecycleCall = func(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
		plan.Called("transaction")
		err := fn(dao)
		return oauthHTTPCompletion(err), err
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
				return oauthHTTPCompletion(ctx.Err()), ctx.Err()
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
		return oauthHTTPCompletion(err), err
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
func oauthHTTPCloneClient(c store.OAuthClient) store.OAuthClient {
	c.Metadata = bytes.Clone(c.Metadata)
	return c
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
func oauthHTTPCloneRotation(r store.OAuthRotation) store.OAuthRotation {
	r.Grant = oauthHTTPCloneGrant(r.Grant)
	r.OldHash = bytes.Clone(r.OldHash)
	r.AccessHash = bytes.Clone(r.AccessHash)
	r.RefreshHash = bytes.Clone(r.RefreshHash)
	return r
}
func oauthHTTPCloneBot(b model.Bot) model.Bot {
	b.ResolvedConfiguration.Args = slices.Clone(b.ResolvedConfiguration.Args)
	b.ResolvedConfiguration.Model = oauthHTTPClonePointer(b.ResolvedConfiguration.Model)
	b.ResolvedConfiguration.ReasoningEffort = oauthHTTPClonePointer(b.ResolvedConfiguration.ReasoningEffort)
	b.ResolvedConfiguration.Selection = oauthHTTPClonePointer(b.ResolvedConfiguration.Selection)
	b.RequestedOverrides.WorkerID = oauthHTTPClonePointer(b.RequestedOverrides.WorkerID)
	b.RequestedOverrides.Cwd = oauthHTTPClonePointer(b.RequestedOverrides.Cwd)
	b.RequestedOverrides.Provider = oauthHTTPClonePointer(b.RequestedOverrides.Provider)
	b.RequestedOverrides.Model = oauthHTTPClonePointer(b.RequestedOverrides.Model)
	b.RequestedOverrides.ReasoningEffort = oauthHTTPClonePointer(b.RequestedOverrides.ReasoningEffort)
	b.RoleConfiguration = oauthHTTPClonePointer(b.RoleConfiguration)
	b.SessionID = oauthHTTPClonePointer(b.SessionID)
	b.TestExecutionID = oauthHTTPClonePointer(b.TestExecutionID)
	b.StartupResult.Code = oauthHTTPClonePointer(b.StartupResult.Code)
	b.Deletion = oauthHTTPClonePointer(b.Deletion)
	if b.Deletion != nil {
		b.Deletion.WorkerCleanup.Code = oauthHTTPClonePointer(b.Deletion.WorkerCleanup.Code)
		b.Deletion.ServerCleanup.Code = oauthHTTPClonePointer(b.Deletion.ServerCleanup.Code)
	}
	return b
}

func oauthHTTPClientFacts(f *oauthHTTPFixture, clientID, redirect string) core.ValidatedClient {
	name, provenance, deadline := "", "preregistered", time.Time{}
	redirects := []string{redirect}
	switch {
	case clientID == "acceptance-client":
		name = "Acceptance"
	case clientID == "known":
		name = "Known"
	case f.ClientBudgetID != "" && clientID == f.ClientBudgetID:
		name = "Public client"
		provenance = "dcr"
		redirects = []string{"http://127.0.0.1/callback"}
		deadline = f.Now.Add(7 * 24 * time.Hour)
	default:
		unexpectedHTTPCall(f.Store.t, "OAuth fixture client configuration")
	}
	metadata := core.ClientMetadata{ClientID: clientID, ClientName: name, RedirectURIs: redirects, TokenEndpointAuthMethod: "none"}
	canonical, err := json.Marshal(metadata)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(canonical)
	return core.ValidatedClient{ClientID: clientID, Provenance: provenance, ClientName: name, MetadataDigest: hex.EncodeToString(digest[:]), Redirects: slices.Clone(redirects), SelectedExactRedirect: redirect, MetadataDeadline: deadline}
}
