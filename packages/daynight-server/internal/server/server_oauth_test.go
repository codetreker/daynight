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
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
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

func TestOAuthPublicProfileProductionRoutes(t *testing.T) {
	h := newOAuthHTTPFixture(t)
	session := h.Session
	config := configuredTestConfig()
	config.Server.PublicOrigin, config.Server.AllowHTTPTestOrigin = h.Origin, true
	config.UniAuth.CallbackURL = h.Origin + "/api/v1/auth/callback"
	config.OAuth.PreregisteredClients = map[string][]byte{"known": []byte(`{"client_id":"known","client_name":"Known","redirect_uris":["https://client.example/callback"]}`)}
	handler, err := newTestHandler(Dependencies{Store: h.Store, Files: attachmentTestFiles(t)}, config, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer handler.(Handler).Shutdown(context.Background())
	send := func(method, path, body, contentType string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.RemoteAddr = "127.0.0.1:12345"
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		if method == http.MethodPost {
			req.Header.Set("Origin", h.Origin)
		}
		for _, cookie := range cookies {
			req.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, req)
		return w
	}
	w := send("POST", "/mcp", "", "")
	if w.Code != http.StatusUnauthorized || w.Header().Get("WWW-Authenticate") != `Bearer resource_metadata="`+h.Origin+`/.well-known/oauth-protected-resource/mcp"` {
		t.Fatalf("challenge: %d %q", w.Code, w.Header().Get("WWW-Authenticate"))
	}
	w = send("GET", "/.well-known/oauth-authorization-server", "", "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"registration_endpoint":"`+h.Origin+`/oauth/register"`) {
		t.Fatalf("metadata: %d %s", w.Code, w.Body.String())
	}
	const callback = "http://127.0.0.1:9012/callback"
	var registered store.OAuthClient
	registerPlan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "client_insert": 1})
	registerDAO := &oauthHTTPClientDAO{t: t, plan: registerPlan, insert: func(in store.OAuthClient, capacity int, now time.Time) (bool, error) {
		var metadata map[string]any
		if json.Unmarshal(in.Metadata, &metadata) != nil || in.ID == "" || metadata["client_id"] != in.ID || metadata["client_name"] != "Public client" || capacity != 10000 || !in.CreatedAt.Equal(now) || !in.LastUsedAt.Equal(now) || in.ExpiresAt.Sub(now) != 7*24*time.Hour {
			t.Errorf("client registration arguments: %+v", in)
		}
		registered = oauthHTTPCloneClient(in)
		return true, nil
	}}
	h.Store.WriteOAuthClientsCall = func(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
		registerPlan.Called("transaction")
		e := fn(oauthHTTPClientScope{clients: registerDAO})
		return oauthHTTPCompletion(e), e
	}
	w = send("POST", "/oauth/register", `{"client_name":"Public client","redirect_uris":["http://127.0.0.1/callback"]}`, "application/json")
	if w.Code != http.StatusCreated {
		t.Fatalf("register: %d %s", w.Code, w.Body.String())
	}
	var registration struct {
		ClientID string `json:"client_id"`
		Method   string `json:"token_endpoint_auth_method"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &registration); err != nil || registration.ClientID == "" || registration.Method != "none" {
		t.Fatalf("registration: %#v %v", registration, err)
	}
	if registered.ID != registration.ClientID {
		t.Fatal("registered response differs from candidate ID")
	}
	h.ClientBudgetID = registration.ClientID
	verifier := strings.Repeat("v", 43)
	hash := sha256.Sum256([]byte(verifier))
	q := url.Values{"client_id": {registration.ClientID}, "redirect_uri": {callback}, "response_type": {"code"}, "scope": {"daynight:mcp"}, "resource": {h.Origin + "/mcp"}, "state": {"state"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(hash[:])}, "code_challenge_method": {"S256"}}
	known := url.Values{}
	for key, value := range q {
		known[key] = value
	}
	known.Set("client_id", "known")
	known.Set("redirect_uri", "https://client.example/callback")
	oauthHTTPExpectStart(t, h, "known", "https://client.example/callback", "state")
	if got := send("GET", "/oauth/authorize?"+known.Encode(), "", ""); got.Code != http.StatusSeeOther {
		t.Fatalf("preregistered client: %d", got.Code)
	}
	clientPlan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "client_read": 1, "client_pin": 1})
	clientRecord := store.OAuthClient{ID: registration.ClientID, Metadata: json.RawMessage(`{"client_id":"` + registration.ClientID + `","client_name":"Public client","redirect_uris":["http://127.0.0.1/callback"]}`), CreatedAt: h.Now, LastUsedAt: h.Now, ExpiresAt: h.Now.Add(7 * 24 * time.Hour)}
	clientDAO := &oauthHTTPClientDAO{t: t, plan: clientPlan, read: func(id string, lock bool) (store.OAuthClient, error) {
		if id != registration.ClientID || !lock {
			unexpectedHTTPCall(t, "registered client lookup")
		}
		return clientRecord, nil
	}, pin: func(id string, now time.Time) (store.OAuthClient, error) {
		if id != registration.ClientID || now.IsZero() {
			unexpectedHTTPCall(t, "registered client pin")
		}
		return clientRecord, nil
	}}
	h.Store.WriteOAuthClientsCall = func(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
		clientPlan.Called("transaction")
		e := fn(oauthHTTPClientScope{clients: clientDAO})
		return oauthHTTPCompletion(e), e
	}
	startCapture := oauthHTTPExpectStart(t, h, registration.ClientID, callback, "state")
	w = send("GET", "/oauth/authorize?"+q.Encode(), "", "")
	if w.Code != http.StatusSeeOther || len(w.Result().Cookies()) != 1 {
		t.Fatalf("start: %d %s", w.Code, w.Body.String())
	}
	location, err := url.Parse(w.Header().Get("Location"))
	if err != nil || location.Path != "/oauth/consent" {
		t.Fatalf("location: %s %v", w.Header().Get("Location"), err)
	}
	id, binding := location.Query().Get("request"), w.Result().Cookies()[0]
	if captured := startCapture.Load(); captured == nil || captured.ID != id || !bytesEqualOAuthHash(binding.Value, captured.BindingHash) {
		t.Fatal("production authorization response differs from inserted request/binding")
	}
	pending := oauthHTTPPending(h, id, binding.Value, "state", registration.ClientID, callback, "dcr")
	w = send("GET", location.String(), "", "", session, binding)
	if w.Code != http.StatusOK || w.Header().Get("Referrer-Policy") != "no-referrer" {
		t.Fatalf("consent: %d %s", w.Code, w.Body.String())
	}
	oauthHTTPRead(t, h, pending)
	w = send("GET", "/api/v1/oauth/requests/"+id, "", "", session, binding)
	var view struct{ UserID, Status, ClientProvenance string }
	if err := json.Unmarshal(w.Body.Bytes(), &view); err != nil || w.Code != 200 || view.UserID == "" || view.Status != "pending" || view.ClientProvenance != "dcr" {
		t.Fatalf("inspect: %d %s %v", w.Code, w.Body.String(), err)
	}
	wrongAccount, _ := json.Marshal(map[string]string{"expectedUserId": "00000000-0000-4000-8000-000000000001", "decision": "approve"})
	w = send("POST", "/api/v1/oauth/requests/"+id+"/decision", string(wrongAccount), "application/json", session, binding)
	if w.Code == http.StatusOK {
		t.Fatal("decision accepted a changed account")
	}
	body, _ := json.Marshal(map[string]string{"expectedUserId": view.UserID, "decision": "approve"})
	decisionCapture := oauthHTTPDecision(t, h, pending, "approved")
	w = send("POST", "/api/v1/oauth/requests/"+id+"/decision", string(body), "application/json", session, binding)
	var decision struct {
		RedirectURI string `json:"redirectUri"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &decision); err != nil || w.Code != 200 {
		t.Fatalf("decision: %d %s %v", w.Code, w.Body.String(), err)
	}
	redirect, err := url.Parse(decision.RedirectURI)
	if err != nil || redirect.Host != "127.0.0.1:9012" || redirect.Query().Get("state") != "state" || redirect.Query().Get("iss") != h.Origin {
		t.Fatalf("redirect: %s %v", decision.RedirectURI, err)
	}
	if captured := decisionCapture.Load(); captured == nil || !bytesEqualOAuthHash(redirect.Query().Get("code"), captured.CodeHash) {
		t.Fatal("approval response code differs from candidate hash")
	}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {redirect.Query().Get("code")}, "client_id": {registration.ClientID}, "redirect_uri": {callback}, "resource": {h.Origin + "/mcp"}, "code_verifier": {verifier}}
	approved := oauthHTTPApproved(h, pending, redirect.Query().Get("code"))
	var issue store.OAuthFamilyIssue
	oauthHTTPExpectRedeem(t, h, approved, true, false, false, &issue)
	w = send("POST", "/oauth/token", form.Encode(), "application/x-www-form-urlencoded")
	var token struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &token); err != nil || w.Code != 200 || token.AccessToken == "" || token.RefreshToken == "" {
		t.Fatalf("token: %d %v", w.Code, err)
	}
	if !bytesEqualOAuthHash(token.AccessToken, issue.AccessHash) || !bytesEqualOAuthHash(token.RefreshToken, issue.RefreshHash) {
		t.Fatal("issued token hashes differ from candidate")
	}
	h.Store.WriteCredentialFamilyCall = func(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error) {
		plan := newHTTPCallPlan(t, map[string]int{"authenticate": 1})
		dao := &oauthHTTPFamilyDAO{t: t, plan: plan, authenticate: func(hash []byte, resource, scope string, now time.Time) (store.OAuthAccessIdentity, error) {
			if !bytesEqualOAuthHash(token.AccessToken, hash) || resource != h.Origin+"/mcp" || scope != core.Scope || now.IsZero() {
				unexpectedHTTPCall(t, "public profile access authentication")
			}
			return store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: h.Principal.UserID, CredentialID: issue.AccessID}, GrantID: issue.Grant.ID}, nil
		}}
		e := fn(oauthHTTPFamilyScope{families: dao})
		return oauthHTTPCompletion(e), e
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	client := mcpPATClient(t, server.URL, token.AccessToken)
	if _, err := client.ListTools(ctx, nil); err != nil {
		t.Fatalf("OAuth MCP: %v", err)
	}
	rotate := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {token.RefreshToken}, "client_id": {registration.ClientID}, "resource": {h.Origin + "/mcp"}}
	var rotation store.OAuthRotation
	oauthHTTPExpectRotate(t, h, token.RefreshToken, issue.Grant, false, false, &rotation)
	w = send("POST", "/oauth/token", rotate.Encode(), "application/x-www-form-urlencoded")
	var renewed struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &renewed); err != nil || w.Code != http.StatusOK || renewed.AccessToken == "" || renewed.RefreshToken == "" || renewed.RefreshToken == token.RefreshToken {
		t.Fatalf("refresh: %d %v", w.Code, err)
	}
	if !bytesEqualOAuthHash(renewed.AccessToken, rotation.AccessHash) || !bytesEqualOAuthHash(renewed.RefreshToken, rotation.RefreshHash) {
		t.Fatal("renewed response differs from candidate token hashes")
	}
	revoke := url.Values{"token": {renewed.RefreshToken}, "client_id": {registration.ClientID}}
	oauthHTTPExpectRevoke(t, h, renewed.RefreshToken, issue.Grant, false)
	w = send("POST", "/oauth/revoke", revoke.Encode(), "application/x-www-form-urlencoded")
	if w.Code != http.StatusOK {
		t.Fatalf("revoke: %d", w.Code)
	}
	oauthHTTPExpectAccess(t, h, renewed.AccessToken, h.Origin+"/mcp", model.Principal{}, "", model.ErrNotFound)
	req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
	req.Header.Set("Authorization", "Bearer "+renewed.AccessToken)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("revoked OAuth access status: %d", w.Code)
	}
}

func bytesEqualOAuthHash(token string, hash []byte) bool {
	return string(secret.Hash(token)) == string(hash)
}

func TestProductionOAuthInvalidClientAndCallbackErrorPage(t *testing.T) {
	fixture := newOAuthHTTPFixture(t)
	config := configuredTestConfig()
	handler, err := newTestHandler(Dependencies{Store: fixture.Store, Files: attachmentTestFiles(t)}, config, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	defer handler.(Handler).Shutdown(context.Background())
	registrationPlan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "client_insert": 1})
	var issuedID string
	dao := &oauthHTTPClientDAO{t: t, plan: registrationPlan, insert: func(client store.OAuthClient, capacity int, now time.Time) (bool, error) {
		var metadata core.ClientMetadata
		if err := json.Unmarshal(client.Metadata, &metadata); err != nil {
			t.Errorf("registered metadata: %v", err)
		}
		want := core.ClientMetadata{ClientID: client.ID, ClientName: "example", RedirectURIs: []string{"https://client.example/callback"}, TokenEndpointAuthMethod: "none"}
		if client.ID == "" || !strings.HasPrefix(client.ID, "dnoac_") || !reflect.DeepEqual(metadata, want) || capacity != 10000 || now.IsZero() || now.Location() != time.UTC || client.CreatedAt != now || client.LastUsedAt != now || client.ExpiresAt != now.Add(7*24*time.Hour) {
			t.Errorf("client registration arguments: %#v %#v capacity=%d at=%v", client, metadata, capacity, now)
		}
		issuedID = client.ID
		return true, nil
	}}
	fixture.Store.WriteOAuthClientsCall = func(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
		registrationPlan.Called("transaction")
		err := fn(oauthHTTPClientScope{clients: dao})
		return oauthHTTPCompletion(err), err
	}
	registration := httptest.NewRequest(http.MethodPost, "/oauth/register", strings.NewReader(`{"client_name":"example","redirect_uris":["https://client.example/callback"]}`))
	registration.RemoteAddr = "127.0.0.1:1234"
	registration.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, registration)
	var client struct {
		ID string `json:"client_id"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &client); err != nil || w.Code != http.StatusCreated || client.ID == "" || client.ID != issuedID {
		t.Fatalf("register status: %d %v", w.Code, err)
	}
	registrationPlan.Verify()
	challenge := sha256.Sum256([]byte(strings.Repeat("v", 43)))
	for _, clientID := range []string{"unknown-client", client.ID} {
		plan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "client_read": 1})
		lookup := &oauthHTTPClientDAO{t: t, plan: plan, read: func(id string, lock bool) (store.OAuthClient, error) {
			if id != clientID || !lock {
				t.Errorf("client lookup arguments: %q lock=%v, want %q/true", id, lock, clientID)
			}
			if clientID == "unknown-client" {
				return store.OAuthClient{}, model.ErrNotFound
			}
			metadata, err := json.Marshal(core.ClientMetadata{ClientID: issuedID, ClientName: "example", RedirectURIs: []string{"https://client.example/callback"}, TokenEndpointAuthMethod: "none"})
			if err != nil {
				t.Error(err)
			}
			return store.OAuthClient{ID: issuedID, Metadata: metadata, CreatedAt: fixture.Now, LastUsedAt: fixture.Now, ExpiresAt: fixture.Now.Add(time.Hour)}, nil
		}}
		fixture.Store.WriteOAuthClientsCall = func(ctx context.Context, fn func(store.OAuthClientScope) error) (store.Completion, error) {
			plan.Called("transaction")
			err := fn(oauthHTTPClientScope{clients: lookup})
			return oauthHTTPCompletion(err), err
		}
		q := url.Values{"client_id": {clientID}, "redirect_uri": {"https://evil.example/callback"}, "response_type": {"code"}, "scope": {"daynight:mcp"}, "resource": {config.Server.PublicOrigin + "/mcp"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(challenge[:])}, "code_challenge_method": {"S256"}}
		r := httptest.NewRequest(http.MethodGet, "/oauth/authorize?"+q.Encode(), nil)
		r.RemoteAddr = "127.0.0.1:1234"
		r.Header.Set("Accept", "text/html,application/xhtml+xml")
		w = httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusBadRequest || !strings.HasPrefix(w.Header().Get("Content-Type"), "text/html") || w.Header().Get("Location") != "" || w.Header().Get("X-OAuth-Error") != "invalid_client" || w.Header().Get("Referrer-Policy") != "no-referrer" || strings.Contains(w.Body.String(), "evil.example") {
			t.Fatalf("invalid start: %d %v", w.Code, w.Header())
		}
		plan.Verify()
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	for key, count := range map[string]int{"oauth:register:global": 1, "oauth:register:source:127.0.0.1": 1, "oauth:start:global": 2, "oauth:start:source:127.0.0.1": 2} {
		if fixture.Rates[key] != count {
			t.Errorf("admission calls for %s: %d, want %d", key, fixture.Rates[key], count)
		}
	}
}

func TestOAuthAccessBusinessAdmission(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	f := newOAuthHTTPFixture(t)
	f.Origin = "https://daynight.test"
	const grantID = "e5555555-5555-4555-8555-555555555555"
	const accessID = "f6666666-6666-4666-8666-666666666666"
	const replacementID = "a7777777-7777-4777-8777-777777777777"
	token := httpTestToken(model.OAuthCredential)
	replacement := "dnmcp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA"
	p := model.Principal{Kind: model.OAuthCredential, UserID: f.Principal.UserID, CredentialID: accessID}
	replacementPrincipal := p
	replacementPrincipal.CredentialID = replacementID
	resource := f.Origin + "/mcp"
	var authentications atomic.Int32
	configureAccess := func(refused bool) {
		f.Store.WriteCredentialFamilyCall = func(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error) {
			plan := newHTTPCallPlan(t, map[string]int{"authenticate": 1})
			dao := &oauthHTTPFamilyDAO{t: t, plan: plan, authenticate: func(hash []byte, actualResource, scope string, now time.Time) (store.OAuthAccessIdentity, error) {
				authentications.Add(1)
				if actualResource != resource || scope != "daynight:mcp" || now.IsZero() || now.Location() != time.UTC {
					unexpectedHTTPCall(t, "MCP OAuth credential scope")
				}
				if !bytes.Equal(hash, secret.Hash(token)) && !bytes.Equal(hash, secret.Hash(replacement)) {
					unexpectedHTTPCall(t, "MCP OAuth token hash")
				}
				if refused {
					return store.OAuthAccessIdentity{}, model.ErrNotFound
				}
				actor := p
				if bytes.Equal(hash, secret.Hash(replacement)) {
					actor = replacementPrincipal
				}
				return store.OAuthAccessIdentity{Principal: actor, GrantID: grantID}, nil
			}}
			e := fn(oauthHTTPFamilyScope{families: dao})
			return oauthHTTPCompletion(e), e
		}
	}
	configureAccess(false)
	config := configuredTestConfig()
	config.Server.PublicOrigin = f.Origin
	config.UniAuth.CallbackURL = f.Origin + "/api/v1/auth/callback"
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	production, err := newTestHandler(Dependencies{Store: f.Store, Files: attachmentTestFiles(t)}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	defer production.(Handler).Shutdown(context.Background())
	productionServer := httptest.NewServer(httpx.RequestLogging(logger, production))
	defer productionServer.Close()
	productionClient := mcpPATClient(t, productionServer.URL, token)
	if _, err = productionClient.ListTools(ctx, nil); err != nil {
		t.Fatalf("production MCP OAuth: %v", err)
	}
	replacementClient := mcpPATClient(t, productionServer.URL, replacement)
	if _, err = replacementClient.ListTools(ctx, nil); err != nil {
		t.Fatalf("production MCP replacement OAuth: %v", err)
	}
	const personalTeam = "b8888888-8888-4888-8888-888888888888"
	const privateTeam = "c9999999-9999-4999-8999-999999999999"
	f.PersonalTeamID = personalTeam
	for _, tc := range []struct {
		team   string
		denied bool
	}{{"personal", false}, {privateTeam, true}} {
		plan := newHTTPCallPlan(t, map[string]int{"snapshot": 1, "team": 1})
		snapshot := newHTTPTestSnapshot(t)
		snapshot.Teams = &oauthMCPTeamReader{t: t, plan: plan, actor: p.UserID, selector: tc.team, id: personalTeam, denied: tc.denied}
		f.Store.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
			plan.Called("snapshot")
			return fn(snapshot)
		}
		result, e := productionClient.CallTool(ctx, &sdk.CallToolParams{Name: "team_show", Arguments: map[string]any{"team": tc.team}})
		if e != nil || result.IsError != tc.denied {
			t.Fatalf("OAuth Team read %s: %#v %v", tc.team, result, e)
		}
		raw, e := json.Marshal(result.StructuredContent)
		if e != nil {
			t.Fatal(e)
		}
		var envelope struct {
			Data struct {
				Membership struct {
					UserID string `json:"userId"`
				}
			}
			Error struct{ Code string }
		}
		if json.Unmarshal(raw, &envelope) != nil || (!tc.denied && envelope.Data.Membership.UserID != p.UserID) || (tc.denied && envelope.Error.Code != "not_found") {
			t.Fatalf("OAuth Team read: %s", raw)
		}
	}
	const projectID = "d1111111-1111-4111-8111-111111111111"
	const taskID = "e2222222-2222-4222-8222-222222222222"
	for _, path := range []string{"/api/v1/projects", "/api/v1/projects/" + projectID + "/tasks/" + taskID + "/worker-claim"} {
		r := httptest.NewRequest(http.MethodPost, path, nil)
		if path == "/api/v1/projects" {
			r.Method = http.MethodGet
		}
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		production.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("OAuth on REST %s: %d", path, w.Code)
		}
	}
	threads := taskservice.NewTaskThreads(f.Store, nil)
	bot := model.Bot{ID: "a4444444-4444-4444-8444-444444444444", OwnerUserID: p.UserID, Version: 1}
	deletions := botservice.NewDeletions(f.Store, nil, sessioncore.NewEngine(nil))
	deletion := store.DeleteBot{Version: bot.Version, DeletionID: "c6666666-6666-4666-8666-666666666666"}
	configureAccess(true)
	oauthMCPThreadRefused(t, f, p, projectID, taskID)
	oauthMCPDeleteRefused(t, f, p)
	var threadError, botError error
	done := make(chan struct{}, 2)
	go func() {
		_, threadError = threads.Post(ctx, p, projectID, taskID, taskservice.CreateThreadMessage{Body: "credential refusal"})
		done <- struct{}{}
	}()
	go func() { _, botError = deletions.DeleteBot(ctx, p, bot.ID, deletion); done <- struct{}{} }()
	for range 2 {
		select {
		case <-done:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	if threadError == nil || botError == nil {
		t.Fatal("concurrent business calls accepted refused credentials")
	}
	if _, err = productionClient.ListTools(ctx, nil); err == nil {
		t.Fatal("production MCP accepted refused access")
	}
	if _, err = replacementClient.ListTools(ctx, nil); err == nil {
		t.Fatal("production MCP accepted refused replacement access")
	}
	if authentications.Load() == 0 {
		t.Fatal("MCP authentication did not execute")
	}
}

type oauthMCPTeamReader struct {
	store.TeamReader
	t                   *testing.T
	plan                *httpCallPlan
	actor, selector, id string
	denied              bool
}

func (d *oauthMCPTeamReader) Team(_ context.Context, user, id string) (model.Team, error) {
	d.plan.Called("team")
	expected := d.selector
	if expected == "personal" {
		expected = d.id
	}
	if user != d.actor || id != expected {
		unexpectedHTTPCall(d.t, "OAuth Team read arguments")
	}
	if d.denied {
		return model.Team{}, model.ErrNotFound
	}
	return model.Team{TeamRef: model.TeamRef{ID: d.id, Kind: "personal"}, Version: 1, Membership: model.TeamMember{TeamID: d.id, UserID: user, Role: model.ProjectAdmin, Version: 1}}, nil
}

type oauthMCPThreadScope struct {
	store.ThreadScope
	dao *oauthMCPThreadRefusalDAO
}

func (s oauthMCPThreadScope) TaskDAO() store.ThreadTaskDAO             { return s.dao }
func (s oauthMCPThreadScope) CredentialDAO() store.ThreadCredentialDAO { return s.dao }

type oauthMCPThreadRefusalDAO struct {
	store.ThreadTaskDAO
	store.ThreadCredentialDAO
	t             *testing.T
	plan          *httpCallPlan
	principal     model.Principal
	project, task string
}

func (d *oauthMCPThreadRefusalDAO) LockTaskPresence(_ context.Context, project, task string) (store.TaskPresence, error) {
	d.plan.Called("task")
	if project != d.project || task != d.task {
		unexpectedHTTPCall(d.t, "OAuth Thread Task scope")
	}
	return store.TaskPresence{Found: true}, nil
}
func (d *oauthMCPThreadRefusalDAO) Credential(_ context.Context, p model.Principal) (store.ThreadCredential, error) {
	d.plan.Called("credential")
	if p != d.principal {
		unexpectedHTTPCall(d.t, "OAuth Thread principal")
	}
	return store.ThreadCredential{}, model.ErrNotFound
}
func oauthMCPThreadRefused(t *testing.T, f *oauthHTTPFixture, p model.Principal, project, task string) {
	plan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "task": 1, "credential": 1})
	dao := &oauthMCPThreadRefusalDAO{t: t, plan: plan, principal: p, project: project, task: task}
	f.Store.WriteThreadCall = func(ctx context.Context, fn func(store.ThreadScope) error) (store.Completion, error) {
		plan.Called("transaction")
		e := fn(oauthMCPThreadScope{dao: dao})
		return oauthHTTPCompletion(e), e
	}
}

type oauthMCPDeleteScope struct {
	store.SessionScope
	dao *oauthMCPDeleteRefusalDAO
}

func (s oauthMCPDeleteScope) SessionDAO() store.SessionDAO { return s.dao }

type oauthMCPDeleteRefusalDAO struct {
	store.SessionDAO
	t         *testing.T
	plan      *httpCallPlan
	principal model.Principal
}

func (d *oauthMCPDeleteRefusalDAO) LockCredential(_ context.Context, p model.Principal, now time.Time) error {
	d.plan.Called("credential")
	if p != d.principal || now.IsZero() {
		unexpectedHTTPCall(d.t, "OAuth deletion credential")
	}
	return model.ErrNotFound
}
func oauthMCPDeleteRefused(t *testing.T, f *oauthHTTPFixture, p model.Principal) {
	plan := newHTTPCallPlan(t, map[string]int{"transaction": 1, "credential": 1})
	dao := &oauthMCPDeleteRefusalDAO{t: t, plan: plan, principal: p}
	f.Store.WriteSessionCall = func(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
		plan.Called("transaction")
		e := fn(oauthMCPDeleteScope{dao: dao})
		return oauthHTTPCompletion(e), e
	}
}
