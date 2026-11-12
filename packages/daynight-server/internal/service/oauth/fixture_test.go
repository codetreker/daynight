package oauth

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type transactionCase struct {
	kind                  string
	runCallback           bool
	callbackExpectedError error
	completion            store.Completion
	finalError            error
}

type oauthFixture struct {
	t             *testing.T
	ctx           context.Context
	now           time.Time
	steps         []string
	transactions  []transactionCase
	current       *oauthScope
	active        bool
	authorization *authorizationCapability
	client        *clientCapability
	family        *familyCapability
	identity      *identityCapability
}

func newOAuthFixture(t *testing.T, steps ...string) *oauthFixture {
	t.Helper()
	type marker struct{}
	f := &oauthFixture{t: t, ctx: context.WithValue(t.Context(), marker{}, "original caller"), now: time.Date(2030, 2, 3, 4, 5, 6, 123456000, time.UTC), steps: steps}
	f.authorization = &authorizationCapability{f: f}
	f.client = &clientCapability{f: f}
	f.family = &familyCapability{f: f}
	f.identity = &identityCapability{f: f}
	t.Cleanup(func() {
		if len(f.steps) != 0 || len(f.transactions) != 0 || f.active {
			t.Errorf("unconsumed calls=%v transactions=%d active=%v", f.steps, len(f.transactions), f.active)
		}
	})
	return f
}
func (f *oauthFixture) step(name string) {
	f.t.Helper()
	if len(f.steps) == 0 || f.steps[0] != name {
		f.t.Fatalf("unexpected %s; remaining %v", name, f.steps)
	}
	f.steps = f.steps[1:]
}
func (f *oauthFixture) equal(got, want any) {
	f.t.Helper()
	if !reflect.DeepEqual(got, want) {
		f.t.Fatalf("got %#v, want %#v", got, want)
	}
}
func (f *oauthFixture) context(ctx context.Context) {
	f.t.Helper()
	if ctx != f.ctx {
		f.t.Fatal("original context was not forwarded")
	}
}
func (f *oauthFixture) dao(ctx context.Context, name string, owner *oauthScope) {
	f.t.Helper()
	f.context(ctx)
	if !f.active || f.current == nil || owner != f.current {
		f.t.Fatal("DAO used outside its callback lifetime")
	}
	f.step(name)
}
func (f *oauthFixture) unexpected(name string) { f.t.Helper(); f.t.Fatalf("unconfigured %s", name) }
func (f *oauthFixture) transaction(ctx context.Context, kind string, callback func(*oauthScope) error) (store.Completion, error) {
	f.context(ctx)
	f.step("writer " + kind)
	if len(f.transactions) == 0 {
		f.t.Fatal("unconfigured transaction")
	}
	plan := f.transactions[0]
	f.transactions = f.transactions[1:]
	f.equal(kind, plan.kind)
	if f.active {
		f.t.Fatal("nested writer callback")
	}
	if plan.runCallback {
		scope := &oauthScope{f: f}
		authorization, client, family, identity := *f.authorization, *f.client, *f.family, *f.identity
		authorization.owner, client.owner, family.owner, identity.owner = scope, scope, scope, scope
		f.authorization, f.client, f.family, f.identity = &authorization, &client, &family, &identity
		f.current = scope
		f.active = true
		err := callback(scope)
		f.active = false
		f.current = nil
		f.step("callback returned")
		if err != plan.callbackExpectedError && !(reflect.TypeOf(err) == reflect.TypeOf(plan.callbackExpectedError) && isExactFault(err, plan.callbackExpectedError)) {
			f.t.Fatalf("callback error %v, want identical %v", err, plan.callbackExpectedError)
		}
	}
	f.step("writer returned")
	return plan.completion, plan.finalError
}
func (f *oauthFixture) WriteAuthorizations(ctx context.Context, callback func(store.AuthorizationScope) error) (store.Completion, error) {
	return f.transaction(ctx, "authorization", func(s *oauthScope) error { return callback(s) })
}
func (f *oauthFixture) WriteOAuthClients(ctx context.Context, callback func(store.OAuthClientScope) error) (store.Completion, error) {
	return f.transaction(ctx, "client", func(s *oauthScope) error { return callback(s) })
}
func (f *oauthFixture) plan(kind string, run bool, callbackError error, outcome store.TransactionOutcome, finalError error) {
	f.transactions = append(f.transactions, transactionCase{kind: kind, runCallback: run, callbackExpectedError: callbackError, completion: store.Completion{Outcome: outcome}, finalError: finalError})
}

type oauthScope struct{ f *oauthFixture }

func (s *oauthScope) capability(name string) {
	s.f.t.Helper()
	if !s.f.active || s.f.current != s {
		s.f.t.Fatal("capability requested outside callback")
	}
	s.f.step("scope " + name)
}
func (s *oauthScope) AuthorizationDAO() store.AuthorizationDAO {
	s.capability("authorization")
	return s.f.authorization
}
func (s *oauthScope) OAuthClientDAO() store.OAuthClientDAO { s.capability("client"); return s.f.client }
func (s *oauthScope) CredentialFamilyDAO() store.CredentialFamilyDAO {
	s.capability("family")
	return s.f.family
}
func (s *oauthScope) IdentityDAO() store.IdentityDAO { s.capability("identity"); return s.f.identity }

type authorizationCapability struct {
	owner  *oauthScope
	f      *oauthFixture
	insert func(store.OAuthAuthorization, int, time.Time) (bool, error)
	read   func(string, bool) (store.OAuthAuthorization, error)
	byCode func([]byte, bool) (store.OAuthAuthorization, error)
	update func(store.OAuthAuthorization) error
	fresh  func(time.Time) (time.Time, error)
}

func (d *authorizationCapability) InsertAuthorization(ctx context.Context, a store.OAuthAuthorization, limit int, now time.Time) (bool, error) {
	d.f.dao(ctx, "insert authorization", d.owner)
	if d.insert == nil {
		d.f.unexpected("InsertAuthorization")
	}
	return d.insert(a, limit, now)
}
func (d *authorizationCapability) Authorization(ctx context.Context, id string, lock bool) (store.OAuthAuthorization, error) {
	d.f.dao(ctx, "read authorization", d.owner)
	if d.read == nil {
		d.f.unexpected("Authorization")
	}
	record, err := d.read(id, lock)
	return cloneAuthorization(record), err
}
func (d *authorizationCapability) AuthorizationByCode(ctx context.Context, hash []byte, lock bool) (store.OAuthAuthorization, error) {
	name := "code unlocked"
	if lock {
		name = "code locked"
	}
	d.f.dao(ctx, name, d.owner)
	if d.byCode == nil {
		d.f.unexpected("AuthorizationByCode")
	}
	record, err := d.byCode(hash, lock)
	return cloneAuthorization(record), err
}
func (d *authorizationCapability) UpdateAuthorization(ctx context.Context, a store.OAuthAuthorization) error {
	d.f.dao(ctx, "update authorization", d.owner)
	if d.update == nil {
		d.f.unexpected("UpdateAuthorization")
	}
	return d.update(a)
}
func (d *authorizationCapability) FreshTime(ctx context.Context, now time.Time) (time.Time, error) {
	d.f.dao(ctx, "fresh", d.owner)
	if d.fresh == nil {
		d.f.unexpected("FreshTime")
	}
	return d.fresh(now)
}
func (d *authorizationCapability) LockAuthorizationCapacity(context.Context) error {
	d.f.unexpected("LockAuthorizationCapacity")
	return nil
}
func (d *authorizationCapability) AuthorizationCleanupCursor(context.Context) (int, error) {
	d.f.unexpected("AuthorizationCleanupCursor")
	return 0, nil
}
func (d *authorizationCapability) SetAuthorizationCleanupCursor(context.Context, int) error {
	d.f.unexpected("SetAuthorizationCleanupCursor")
	return nil
}
func (d *authorizationCapability) ExpiredAuthorizations(context.Context, time.Time, int) ([]store.OAuthAuthorization, error) {
	d.f.unexpected("ExpiredAuthorizations")
	return nil, nil
}
func (d *authorizationCapability) DeleteRetainedAuthorizations(context.Context, time.Time, int) (int, error) {
	d.f.unexpected("DeleteRetainedAuthorizations")
	return 0, nil
}

type clientCapability struct {
	owner  *oauthScope
	f      *oauthFixture
	insert func(store.OAuthClient, int, time.Time) (bool, error)
	read   func(string, bool) (store.OAuthClient, error)
	pin    func(string, time.Time) (store.OAuthClient, error)
}

func (d *clientCapability) InsertClient(ctx context.Context, a store.OAuthClient, limit int, now time.Time) (bool, error) {
	d.f.dao(ctx, "insert client", d.owner)
	if d.insert == nil {
		d.f.unexpected("InsertClient")
	}
	return d.insert(a, limit, now)
}
func (d *clientCapability) Client(ctx context.Context, id string, lock bool) (store.OAuthClient, error) {
	d.f.dao(ctx, "read client", d.owner)
	if d.read == nil {
		d.f.unexpected("Client")
	}
	record, err := d.read(id, lock)
	return cloneOAuthClient(record), err
}
func (d *clientCapability) PinClient(ctx context.Context, id string, now time.Time) (store.OAuthClient, error) {
	d.f.dao(ctx, "pin client", d.owner)
	if d.pin == nil {
		d.f.unexpected("PinClient")
	}
	record, err := d.pin(id, now)
	return cloneOAuthClient(record), err
}
func (d *clientCapability) LockClientCapacity(context.Context) error {
	d.f.unexpected("LockClientCapacity")
	return nil
}
func (d *clientCapability) ExpiredClients(context.Context, time.Time, int) ([]string, error) {
	d.f.unexpected("ExpiredClients")
	return nil, nil
}
func (d *clientCapability) FreshTime(context.Context, time.Time) (time.Time, error) {
	d.f.unexpected("client FreshTime")
	return time.Time{}, nil
}
func (d *clientCapability) DeleteClient(context.Context, string) error {
	d.f.unexpected("DeleteClient")
	return nil
}

type familyCapability struct {
	owner   *oauthScope
	f       *oauthFixture
	inspect func(string, bool) (store.OAuthGrant, error)
	revoke  func(string, time.Time) (bool, error)
}

func (d *familyCapability) InspectGrant(ctx context.Context, id string, lock bool) (store.OAuthGrant, error) {
	name := "grant read"
	if lock {
		name = "grant locked"
	}
	d.f.dao(ctx, name, d.owner)
	if d.inspect == nil {
		d.f.unexpected("InspectGrant")
	}
	grant, err := d.inspect(id, lock)
	return cloneOAuthGrant(grant), err
}
func (d *familyCapability) RevokeFamily(ctx context.Context, id string, now time.Time) (bool, error) {
	d.f.dao(ctx, "revoke family", d.owner)
	if d.revoke == nil {
		d.f.unexpected("RevokeFamily")
	}
	return d.revoke(id, now)
}
func (d *familyCapability) IssueFamily(context.Context, store.OAuthFamilyIssue) error {
	d.f.unexpected("DAO IssueFamily")
	return nil
}
func (d *familyCapability) AuthenticateAccess(context.Context, []byte, []store.OAuthBinding, time.Time) (store.OAuthAccessIdentity, error) {
	d.f.unexpected("DAO AuthenticateAccess")
	return store.OAuthAccessIdentity{}, nil
}
func (d *familyCapability) LockAccess(context.Context, model.Principal, []store.OAuthBinding, time.Time) error {
	d.f.unexpected("LockAccess")
	return nil
}
func (d *familyCapability) ReadAccess(context.Context, model.Principal, []store.OAuthBinding, time.Time) error {
	d.f.unexpected("ReadAccess")
	return nil
}
func (d *familyCapability) ActiveClientReferences(context.Context, string, time.Time) (bool, error) {
	d.f.unexpected("ActiveClientReferences")
	return false, nil
}

type identityCapability struct {
	owner *oauthScope
	f     *oauthFixture
	lock  func(model.Principal, time.Time) error
}

func (d *identityCapability) LockSession(ctx context.Context, p model.Principal, now time.Time) error {
	d.f.dao(ctx, "lock session", d.owner)
	if d.lock == nil {
		d.f.unexpected("LockSession")
	}
	return d.lock(p, now)
}

func fixtureClient() core.ValidatedClient {
	return core.ValidatedClient{ClientID: "client", Provenance: "preregistered", ClientName: "Example", MetadataDigest: "digest", Redirects: []string{"https://client.example/cb"}, SelectedExactRedirect: "https://client.example/cb", MetadataDeadline: time.Date(2030, 2, 4, 0, 0, 0, 0, time.UTC)}
}
func fixturePrincipal() model.Principal {
	return model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
}
func fixtureAuthorization(id string, now time.Time) store.OAuthAuthorization {
	return store.OAuthAuthorization{ID: id, BindingHash: []byte("stored-binding-hash"), Client: []byte(`{"clientId":"client","provenance":"preregistered","clientName":"Example","metadataDigest":"digest","redirects":["https://client.example/cb"],"selectedExactRedirect":"https://client.example/cb","metadataDeadline":"2030-02-04T00:00:00Z"}`), ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: core.Scope, Challenge: fixtureChallenge(), State: "s", StatePresent: true, Status: "pending", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(10*time.Minute + 24*time.Hour)}
}
func fixtureStart() StartInput {
	return StartInput{Source: "test", ClientID: "client", RedirectURI: "https://client.example/cb", ResponseType: "code", Scope: core.Scope, Resource: "https://server.example/mcp", State: "s", StatePresent: true, CodeChallenge: fixtureChallenge(), CodeChallengeMethod: "S256"}
}
func checkAuthorizationError(t *testing.T, got, want error) {
	t.Helper()
	if want == nil {
		if got != nil {
			t.Fatal(got)
		}
		return
	}
	if !errors.Is(got, want) {
		t.Fatalf("error %v does not retain %v", got, want)
	}
}

func (d *identityCapability) CleanupCredentials(context.Context, time.Time) error {
	d.f.unexpected("CleanupCredentials")
	return nil
}

func (d *identityCapability) CleanupLoginCredentials(context.Context, time.Time, time.Time) error {
	d.f.unexpected("CleanupLoginCredentials")
	return nil
}

func (d *identityCapability) AdmitLogin(context.Context, []byte, int, int) (time.Time, string, error) {
	d.f.unexpected("AdmitLogin")
	return time.Time{}, "", nil
}

func (d *identityCapability) InsertLogin(context.Context, model.LoginTransaction) error {
	d.f.unexpected("InsertLogin")
	return nil
}

func (d *identityCapability) ConsumeLogin(context.Context, []byte, []byte, time.Time) (model.LoginTransaction, error) {
	d.f.unexpected("ConsumeLogin")
	return model.LoginTransaction{}, nil
}

func (d *identityCapability) UpsertUser(context.Context, model.User, time.Time) (model.User, error) {
	d.f.unexpected("UpsertUser")
	return model.User{}, nil
}

func (d *identityCapability) LockProfileCredential(context.Context, model.Principal, time.Time) error {
	d.f.unexpected("LockProfileCredential")
	panic("unreachable")
}
func (d *identityCapability) EnsureUser(context.Context, model.User, time.Time) (model.User, bool, error) {
	d.f.unexpected("EnsureUser")
	panic("unreachable")
}
func (d *identityCapability) PatchUser(context.Context, string, model.UserProfilePatch) (model.User, error) {
	d.f.unexpected("PatchUser")
	panic("unreachable")
}
func (d *identityCapability) InsertSession(context.Context, model.Session) error {
	d.f.unexpected("InsertSession")
	return nil
}

func (d *identityCapability) Authenticate(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error) {
	d.f.unexpected("Authenticate")
	return model.Principal{}, nil
}

func (d *identityCapability) IdentityUser(context.Context, string) (model.User, store.PersonalTeamFacts, error) {
	d.f.unexpected("IdentityUser")
	return model.User{}, store.PersonalTeamFacts{}, nil
}

func (d *identityCapability) IdentityPersonalTeam(context.Context, string) (store.PersonalTeamFacts, error) {
	d.f.unexpected("IdentityPersonalTeam")
	return store.PersonalTeamFacts{}, nil
}

func (d *identityCapability) DeleteSession(context.Context, model.Principal) error {
	d.f.unexpected("DeleteSession")
	return nil
}

func (d *identityCapability) InsertPAT(context.Context, model.PersonalAccessToken) error {
	d.f.unexpected("InsertPAT")
	return nil
}

func (d *identityCapability) ListPATs(context.Context, string, time.Time) ([]model.PersonalAccessToken, error) {
	d.f.unexpected("ListPATs")
	return nil, nil
}

func (d *identityCapability) DeletePAT(context.Context, string, string) error {
	d.f.unexpected("DeletePAT")
	return nil
}

func (d *identityCapability) LockActivePAT(context.Context, string, string, time.Time) (model.PersonalAccessToken, error) {
	d.f.unexpected("LockActivePAT")
	return model.PersonalAccessToken{}, nil
}

func (d *identityCapability) SetPATExpiry(context.Context, string, *time.Time) (model.PersonalAccessToken, error) {
	d.f.unexpected("SetPATExpiry")
	return model.PersonalAccessToken{}, nil
}

func (d *identityCapability) PruneDeviceRates(context.Context, time.Time) error {
	d.f.unexpected("PruneDeviceRates")
	return nil
}

func (d *identityCapability) IncrementDeviceRate(context.Context, model.DeviceRateBucket, time.Time) (int, error) {
	d.f.unexpected("IncrementDeviceRate")
	return 0, nil
}

func (d *identityCapability) PruneDevices(context.Context, time.Time) error {
	d.f.unexpected("PruneDevices")
	return nil
}

func (d *identityCapability) InsertDevice(context.Context, model.DeviceAuthorization) error {
	d.f.unexpected("InsertDevice")
	return nil
}

func (d *identityCapability) DeviceByUserCode(context.Context, string, string, bool) (model.DeviceAuthorization, error) {
	d.f.unexpected("DeviceByUserCode")
	return model.DeviceAuthorization{}, nil
}

func (d *identityCapability) LockDeviceByHash(context.Context, []byte) (model.DeviceAuthorization, error) {
	d.f.unexpected("LockDeviceByHash")
	return model.DeviceAuthorization{}, nil
}

func (d *identityCapability) SetDeviceDecision(context.Context, string, string, string) error {
	d.f.unexpected("SetDeviceDecision")
	return nil
}

func (d *identityCapability) DelayDevicePoll(context.Context, string, time.Time, bool) error {
	d.f.unexpected("DelayDevicePoll")
	return nil
}

func (d *identityCapability) ConsumeDevice(context.Context, string) error {
	d.f.unexpected("ConsumeDevice")
	return nil
}

func rejectClientOperations(f *oauthFixture) clientOperations {
	return clientOperations{
		take: func(context.Context, string, string, string) (bool, error) { f.unexpected("take"); return false, nil },
		parseMetadata: func([]byte, string) (core.ClientMetadata, error) {
			f.unexpected("parse metadata")
			return core.ClientMetadata{}, nil
		},
		parseStoredMetadata: func([]byte, string) (core.ClientMetadata, error) {
			f.unexpected("parse stored metadata")
			return core.ClientMetadata{}, nil
		},
		freezeClient: func(string, string, core.ClientMetadata, time.Time, string) (core.ValidatedClient, error) {
			f.unexpected("freeze client")
			return core.ValidatedClient{}, nil
		},
	}
}
func rejectAuthorizationOperations(f *oauthFixture) authorizationOperations {
	return authorizationOperations{
		take: func(context.Context, string, string, string) (bool, error) { f.unexpected("take"); return false, nil },
		resolveClient: func(context.Context, string, string) (core.ValidatedClient, error) {
			f.unexpected("resolve client")
			return core.ValidatedClient{}, nil
		},
		validStart: func(string, string, string, string, string, string, string) bool {
			f.unexpected("valid start")
			return false
		},
		callbackURI: func(string, url.Values) (string, error) { f.unexpected("callback URI"); return "", nil },
		newAuthorization: func(core.AuthorizationRequest, time.Time) store.OAuthAuthorization {
			f.unexpected("new authorization")
			return store.OAuthAuthorization{}
		},
		validBinding:  func(string) bool { f.unexpected("valid binding"); return false },
		bound:         func(store.OAuthAuthorization, string) bool { f.unexpected("bound"); return false },
		status:        func(store.OAuthAuthorization, time.Time) (string, bool) { f.unexpected("status"); return "", false },
		validDecision: func(string) bool { f.unexpected("valid decision"); return false },
		decide: func(*store.OAuthAuthorization, string, string, string, string, time.Time) (string, error) {
			f.unexpected("decide")
			return "", nil
		},
		validCodeInput: func(string, string, string, string, string) bool { f.unexpected("valid code input"); return false },
		checkBinding:   func(store.OAuthAuthorization, core.CodeBinding) error { f.unexpected("check binding"); return nil },
		checkCode: func(store.OAuthAuthorization, core.CodeBinding, time.Time) (bool, error) {
			f.unexpected("check code")
			return false, nil
		},
		checkExpiry: func(store.OAuthAuthorization, time.Time) error { f.unexpected("check expiry"); return nil },
		issueFamily: func(context.Context, store.CredentialFamilyDAO, core.IssueInput, time.Time) (core.IssuedFamily, error) {
			f.unexpected("issue family")
			return core.IssuedFamily{}, nil
		},
		consume: func(*store.OAuthAuthorization, string, time.Time) { f.unexpected("consume") },
		prune: func(context.Context, store.AuthorizationDAO, time.Time, int) (int, error) {
			f.unexpected("prune")
			return 0, nil
		},
	}
}
func (f *oauthFixture) clients() *Clients {
	return &Clients{writer: f, operations: rejectClientOperations(f), preregistered: map[string]core.ClientMetadata{}, now: func() time.Time { return f.now }}
}
func (f *oauthFixture) service() *Authorizations {
	return &Authorizations{writer: f, operations: rejectAuthorizationOperations(f), issuer: "https://server.example", resource: "https://server.example/mcp", now: func() time.Time { return f.now }}
}

func isExactFault(got, want error) bool {
	a, aok := got.(*model.Fault)
	b, bok := want.(*model.Fault)
	return aok && bok && reflect.DeepEqual(a, b)
}

func fixtureChallenge() string {
	hash := sha256.Sum256([]byte(strings.Repeat("a", 43)))
	return base64.RawURLEncoding.EncodeToString(hash[:])
}

// Supplied results do not share mutable storage with the expected facts.
func cloneAuthorization(record store.OAuthAuthorization) store.OAuthAuthorization {
	record.BindingHash = bytes.Clone(record.BindingHash)
	record.Client = bytes.Clone(record.Client)
	record.CodeHash = bytes.Clone(record.CodeHash)
	if record.CodeExpiresAt != nil {
		expiry := *record.CodeExpiresAt
		record.CodeExpiresAt = &expiry
	}
	return record
}
func cloneOAuthClient(record store.OAuthClient) store.OAuthClient {
	record.Metadata = bytes.Clone(record.Metadata)
	return record
}
func cloneClientMetadata(metadata core.ClientMetadata) core.ClientMetadata {
	metadata.RedirectURIs = slices.Clone(metadata.RedirectURIs)
	metadata.GrantTypes = slices.Clone(metadata.GrantTypes)
	metadata.ResponseTypes = slices.Clone(metadata.ResponseTypes)
	return metadata
}
func cloneValidatedClient(client core.ValidatedClient) core.ValidatedClient {
	client.Redirects = slices.Clone(client.Redirects)
	return client
}
func cloneOAuthGrant(grant store.OAuthGrant) store.OAuthGrant {
	grant.ClientSnapshot = bytes.Clone(grant.ClientSnapshot)
	if grant.RevokedAt != nil {
		revoked := *grant.RevokedAt
		grant.RevokedAt = &revoked
	}
	return grant
}
func cloneIssuedFamily(issued core.IssuedFamily) core.IssuedFamily {
	issued.Grant = cloneOAuthGrant(issued.Grant)
	return issued
}
func fixtureApprovedAuthorization(pending store.OAuthAuthorization, userID, code string, now time.Time) store.OAuthAuthorization {
	approved := cloneAuthorization(pending)
	approved.UserID = userID
	approved.Status = "approved"
	approved.State, approved.StatePresent = "", false
	hash := sha256.Sum256([]byte(code))
	approved.CodeHash = bytes.Clone(hash[:])
	expiry := now.Add(5 * time.Minute)
	approved.CodeExpiresAt = &expiry
	approved.RetainUntil = now.Add(24 * time.Hour)
	return approved
}

func cloneMetadataDocuments(documents map[string][]byte) map[string][]byte {
	result := make(map[string][]byte, len(documents))
	for id, data := range documents {
		result[id] = bytes.Clone(data)
	}
	return result
}
