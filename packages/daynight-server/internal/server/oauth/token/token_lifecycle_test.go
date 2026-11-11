package token

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

// DAO rows and transaction outcomes are controlled logical facts, not
// PostgreSQL readback.
type oauthHTTPFixture struct {
	Store     *oauthHTTPStore
	Principal model.Principal
	Origin    string
	Now       time.Time
	mu        sync.Mutex
	Rates     map[string]int
}

type oauthHTTPStore struct {
	t                         *testing.T
	fixture                   *oauthHTTPFixture
	WriteAuthorizationsCall   func(context.Context, func(store.AuthorizationScope) error) (store.Completion, error)
	WriteCredentialFamilyCall func(context.Context, func(store.CredentialFamilyScope) error) (store.Completion, error)
	WriteGrantLifecycleCall   func(context.Context, func(store.GrantLifecycleDAO) error) (store.Completion, error)
}

func newOAuthHTTPFixture(t *testing.T) *oauthHTTPFixture {
	t.Helper()
	f := &oauthHTTPFixture{Origin: "http://127.0.0.1:8787", Now: time.Now().UTC().Truncate(time.Microsecond), Rates: map[string]int{}, Principal: model.Principal{Kind: model.SessionCredential, UserID: "a1111111-1111-4111-8111-111111111111", CredentialID: "b2222222-2222-4222-8222-222222222222"}}
	f.Store = &oauthHTTPStore{t: t, fixture: f}
	return f
}
func (s *oauthHTTPStore) WriteOAuthClients(context.Context, func(store.OAuthClientScope) error) (store.Completion, error) {
	unexpectedHTTPCall(s.t, "WriteOAuthClients")
	return store.Completion{}, nil
}
func (s *oauthHTTPStore) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	dao := &oauthHTTPIdentityDAO{t: s.t, fixture: s.fixture}
	err := fn(oauthHTTPIdentityScope{dao: dao})
	if dao.prune != 1 || dao.increment < 1 || dao.increment > 2 {
		s.t.Errorf("identity callback calls: prune=%d increment=%d", dao.prune, dao.increment)
	}
	return store.Completion{Outcome: store.TransactionCommitted}, err
}
func (s *oauthHTTPStore) WriteAuthorizations(ctx context.Context, fn func(store.AuthorizationScope) error) (store.Completion, error) {
	if s.WriteAuthorizationsCall == nil {
		unexpectedHTTPCall(s.t, "WriteAuthorizations")
	}
	return s.WriteAuthorizationsCall(ctx, fn)
}
func (s *oauthHTTPStore) WriteCredentialFamily(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error) {
	if s.WriteCredentialFamilyCall == nil {
		unexpectedHTTPCall(s.t, "WriteCredentialFamily")
	}
	return s.WriteCredentialFamilyCall(ctx, fn)
}
func (s *oauthHTTPStore) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	if s.WriteGrantLifecycleCall == nil {
		unexpectedHTTPCall(s.t, "WriteGrantLifecycle")
	}
	return s.WriteGrantLifecycleCall(ctx, fn)
}

type oauthHTTPIdentityScope struct {
	store.IdentityScope
	dao store.IdentityDAO
}

func (s oauthHTTPIdentityScope) IdentityDAO() store.IdentityDAO { return s.dao }
func unexpectedHTTPCall(t *testing.T, name string) {
	t.Helper()
	t.Errorf("unconfigured or extra DAO call: %s", name)
	panic("unconfigured or extra DAO call: " + name)
}

type httpCallPlan struct {
	t          *testing.T
	mu         sync.Mutex
	want, seen map[string]int
}

func newHTTPCallPlan(t *testing.T, want map[string]int) *httpCallPlan {
	t.Helper()
	p := &httpCallPlan{t: t, want: want, seen: map[string]int{}}
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
func bytesEqualOAuthHash(token string, hash []byte) bool {
	return bytes.Equal(secret.Hash(token), hash)
}

type oauthHTTPIdentityDAO struct {
	store.IdentityDAO
	t                *testing.T
	fixture          *oauthHTTPFixture
	prune, increment int
}

func (d *oauthHTTPIdentityDAO) PruneDeviceRates(_ context.Context, now time.Time) error {
	d.prune++
	if d.prune != 1 || d.increment != 0 || now.IsZero() || now.Location() != time.UTC {
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

func oauthHTTPPlan(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, lock bool, want map[string]int, update func(store.OAuthAuthorization) error) {
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
		err := fn(oauthHTTPAuthorizationScope{identities: &oauthHTTPLockedIdentityDAO{t: t, fixture: f, plan: plan}, authorizations: dao})
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}

type oauthHTTPLockedIdentityDAO struct {
	store.IdentityDAO
	t       *testing.T
	fixture *oauthHTTPFixture
	plan    *httpCallPlan
}

func (d *oauthHTTPLockedIdentityDAO) LockSession(_ context.Context, p model.Principal, now time.Time) error {
	d.plan.Called("session")
	if p != d.fixture.Principal || now.IsZero() || now.Location() != time.UTC {
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
	})
	return captured
}

func oauthHTTPExpectAccess(t *testing.T, f *oauthHTTPFixture, token, resource string, p model.Principal, grant string, err error, outcome store.TransactionOutcome) {
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
		return store.Completion{Outcome: outcome}, e
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
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
	return captured
}

func oauthHTTPExpectRedeem(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, issued *store.OAuthFamilyIssue) {
	want := map[string]int{"transaction": 2, "code": 3, "time": 1, "issue": 1, "update": 1}
	locks := []bool{false, false, true}
	var clientFacts core.ValidatedClient
	if json.Unmarshal(row.Client, &clientFacts) != nil {
		t.Fatal("invalid OAuth fixture client")
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
		return store.Completion{Outcome: store.TransactionCommitted}, err
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
	outcome := store.TransactionCommitted
	if wrongClient {
		outcome = store.TransactionNotCommitted
	}
	f.Store.WriteGrantLifecycleCall = func(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
		plan.Called("transaction")
		err := fn(dao)
		return store.Completion{Outcome: outcome}, err
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
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
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
func oauthHTTPCloneRotation(r store.OAuthRotation) store.OAuthRotation {
	r.Grant = oauthHTTPCloneGrant(r.Grant)
	r.OldHash = bytes.Clone(r.OldHash)
	r.AccessHash = bytes.Clone(r.AccessHash)
	r.RefreshHash = bytes.Clone(r.RefreshHash)
	return r
}
func oauthHTTPClientFacts(f *oauthHTTPFixture, clientID, redirect string) core.ValidatedClient {
	if clientID != "acceptance-client" {
		unexpectedHTTPCall(f.Store.t, "OAuth fixture client configuration")
	}
	metadata := core.ClientMetadata{ClientID: clientID, ClientName: "Acceptance", RedirectURIs: []string{redirect}, TokenEndpointAuthMethod: "none"}
	canonical, err := json.Marshal(metadata)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(canonical)
	return core.ValidatedClient{ClientID: clientID, Provenance: "preregistered", ClientName: "Acceptance", MetadataDigest: hex.EncodeToString(digest[:]), Redirects: []string{redirect}, SelectedExactRedirect: redirect}
}
func TestOAuthTokenLifecycleControlledHTTP(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	f := newOAuthHTTPFixture(t)
	admission := core.PublicAdmission{Writer: f.Store, Now: func() time.Time { return f.Now }}
	clients, err := oauthservice.NewClients(f.Store, admission, map[string][]byte{"acceptance-client": []byte(`{"client_id":"acceptance-client","client_name":"Acceptance","redirect_uris":["https://client.example/callback"]}`)})
	if err != nil {
		t.Fatal(err)
	}
	authorizations, err := oauthservice.NewAuthorizations(f.Store, clients, admission, f.Origin)
	if err != nil {
		t.Fatal(err)
	}
	adapter := &PublicTokens{Admission: admission, Resource: f.Origin + "/mcp", Codes: authorizations, Grants: core.NewGrantLifecycle(f.Store)}
	mux := http.NewServeMux()
	mux.HandleFunc("/oauth/token", adapter.Token)
	mux.HandleFunc("/oauth/revoke", adapter.Revoke)
	server := httptest.NewServer(mux)
	defer server.Close()
	client := server.Client()
	client.Timeout = 10 * time.Second
	verifier := strings.Repeat("v", 43)
	digest := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(digest[:])
	const callback = "https://client.example/callback"
	resource := f.Origin + "/mcp"
	code := func() (string, store.OAuthAuthorization) {
		t.Helper()
		startCapture := oauthHTTPExpectStart(t, f, "acceptance-client", callback, "")
		start, e := authorizations.Start(ctx, oauthservice.StartInput{Source: "fixture", ClientID: "acceptance-client", RedirectURI: callback, ResponseType: "code", Scope: core.Scope, Resource: resource, CodeChallenge: challenge, CodeChallengeMethod: "S256"})
		if e != nil {
			t.Fatal(e)
		}
		if captured := startCapture.Load(); captured == nil || captured.ID != start.RequestID || !bytesEqualOAuthHash(start.Binding, captured.BindingHash) {
			t.Fatal("authorization start differs from inserted request/binding")
		}
		pending := oauthHTTPPending(f, start.RequestID, start.Binding, "", "acceptance-client", callback, "preregistered")
		pending.StatePresent = false
		decisionCapture := oauthHTTPDecision(t, f, pending, "approved")
		decision, e := authorizations.Decide(ctx, oauthservice.DecisionInput{RequestID: start.RequestID, Binding: start.Binding, ExpectedUserID: f.Principal.UserID, Decision: "approve", Principal: f.Principal})
		if e != nil {
			t.Fatal(e)
		}
		u, e := url.Parse(decision.RedirectURI)
		if e != nil || u.Query().Get("code") == "" {
			t.Fatalf("decision callback: %v", e)
		}
		if captured := decisionCapture.Load(); captured == nil || !bytesEqualOAuthHash(u.Query().Get("code"), captured.CodeHash) {
			t.Fatal("authorization code differs from candidate hash")
		}
		return u.Query().Get("code"), oauthHTTPApproved(f, pending, u.Query().Get("code"))
	}
	post := func(path string, v url.Values) (int, []byte) {
		t.Helper()
		req, e := http.NewRequestWithContext(ctx, http.MethodPost, server.URL+path, strings.NewReader(v.Encode()))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		resp, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		b, e := io.ReadAll(resp.Body)
		if e != nil {
			t.Fatal(e)
		}
		if resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("credential response lacks no-store")
		}
		return resp.StatusCode, b
	}
	type tokens struct {
		Access  string `json:"access_token"`
		Refresh string `json:"refresh_token"`
		Type    string `json:"token_type"`
		Scope   string `json:"scope"`
		Expires int64  `json:"expires_in"`
	}
	exchange := func() (tokens, store.OAuthFamilyIssue) {
		t.Helper()
		c, row := code()
		var issue store.OAuthFamilyIssue
		oauthHTTPExpectRedeem(t, f, row, &issue)
		status, b := post("/oauth/token", url.Values{"grant_type": {"authorization_code"}, "code": {c}, "client_id": {"acceptance-client"}, "redirect_uri": {callback}, "resource": {resource}, "code_verifier": {verifier}})
		var out tokens
		if status != 200 || json.Unmarshal(b, &out) != nil || out.Access == "" || out.Refresh == "" || out.Type != "Bearer" || out.Scope != core.Scope || out.Expires <= 0 {
			t.Fatalf("exchange: %d %s", status, b)
		}
		if !bytesEqualOAuthHash(out.Access, issue.AccessHash) || !bytesEqualOAuthHash(out.Refresh, issue.RefreshHash) {
			t.Fatal("token secrets differ from issued hashes")
		}
		return out, issue
	}
	refreshForm := func(token, clientID, res string) url.Values {
		return url.Values{"grant_type": {"refresh_token"}, "refresh_token": {token}, "client_id": {clientID}, "resource": {res}}
	}
	first, firstIssue := exchange()
	var unused store.OAuthRotation
	oauthHTTPExpectRotate(t, f, first.Refresh, firstIssue.Grant, false, true, &unused)
	if status, _ := post("/oauth/token", refreshForm(first.Refresh, "wrong", resource)); status != http.StatusBadRequest {
		t.Fatalf("wrong client status: %d", status)
	}
	f.Store.WriteGrantLifecycleCall = nil
	if status, _ := post("/oauth/token", refreshForm(first.Refresh, "acceptance-client", f.Origin+"/other")); status != http.StatusBadRequest {
		t.Fatalf("wrong resource status: %d", status)
	}
	var rotation store.OAuthRotation
	oauthHTTPExpectRotate(t, f, first.Refresh, firstIssue.Grant, false, false, &rotation)
	status, b := post("/oauth/token", refreshForm(first.Refresh, "acceptance-client", resource))
	var rotated tokens
	if status != 200 || json.Unmarshal(b, &rotated) != nil || rotated.Access == "" || rotated.Refresh == "" || rotated.Refresh == first.Refresh {
		t.Fatalf("rotation: %d %s", status, b)
	}
	if !bytesEqualOAuthHash(rotated.Access, rotation.AccessHash) || !bytesEqualOAuthHash(rotated.Refresh, rotation.RefreshHash) {
		t.Fatal("rotated secrets differ from candidate hashes")
	}
	auth := oauthservice.NewAuthenticator(f.Store)
	principal := model.Principal{Kind: model.OAuthCredential, UserID: f.Principal.UserID, CredentialID: rotation.AccessID}
	oauthHTTPExpectAccess(t, f, rotated.Access, resource, principal, firstIssue.Grant.ID, nil, store.TransactionCommitted)
	if _, err = auth.AuthenticateAccess(ctx, rotated.Access, resource); err != nil {
		t.Fatalf("rotated access rejected: %v", err)
	}
	oauthHTTPExpectRotate(t, f, first.Refresh, firstIssue.Grant, true, false, &unused)
	if status, _ = post("/oauth/token", refreshForm(first.Refresh, "acceptance-client", resource)); status != http.StatusBadRequest {
		t.Fatalf("replay status: %d", status)
	}
	for _, access := range []string{first.Access, rotated.Access} {
		oauthHTTPExpectAccess(t, f, access, resource, model.Principal{}, "", model.ErrNotFound, store.TransactionNotCommitted)
		if _, err = auth.AuthenticateAccess(ctx, access, resource); err == nil {
			t.Fatal("replay left access usable")
		}
	}
	second, secondIssue := exchange()
	oauthHTTPExpectRevoke(t, f, second.Refresh, secondIssue.Grant, true)
	if status, _ = post("/oauth/revoke", url.Values{"token": {second.Refresh}, "client_id": {"wrong"}}); status != http.StatusOK {
		t.Fatalf("wrong client revoke: %d", status)
	}
	principal.CredentialID = secondIssue.AccessID
	oauthHTTPExpectAccess(t, f, second.Access, resource, principal, secondIssue.Grant.ID, nil, store.TransactionCommitted)
	if _, err = auth.AuthenticateAccess(ctx, second.Access, resource); err != nil {
		t.Fatal("wrong client revoked access")
	}
	oauthHTTPExpectRevoke(t, f, second.Refresh, secondIssue.Grant, false)
	if status, _ = post("/oauth/revoke", url.Values{"token": {second.Refresh}, "client_id": {"acceptance-client"}}); status != http.StatusOK {
		t.Fatalf("revoke: %d", status)
	}
	oauthHTTPExpectAccess(t, f, second.Access, resource, model.Principal{}, "", model.ErrNotFound, store.TransactionNotCommitted)
	if _, err = auth.AuthenticateAccess(ctx, second.Access, resource); err == nil {
		t.Fatal("public revoke left access usable")
	}
	for _, tc := range []struct {
		key  string
		want int
	}{{"oauth:token:global", 6}, {"oauth:token:source:127.0.0.1", 6}, {"oauth:token:client:acceptance-client", 4}} {
		if f.Rates[tc.key] != tc.want {
			t.Fatalf("budget DAO calls %s: %d want %d", tc.key, f.Rates[tc.key], tc.want)
		}
	}
	if f.Rates["oauth:token:client:wrong"] != 0 {
		t.Fatal("unverified client obtained a budget")
	}
}
