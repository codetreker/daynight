package oauth

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type familyDAO struct {
	t                          *testing.T
	issueContext               context.Context
	wantIssueCalls, issueCalls int
	allowAuthentication        bool
	issue                      store.OAuthFamilyIssue
	issueErr, authErr          error
	identity                   store.OAuthAccessIdentity
	authHash                   []byte
	resource, scope            string
	now                        time.Time
	issued, authenticated      bool
}

func newIssuanceDAO(t *testing.T, ctx context.Context, calls int) *familyDAO {
	t.Helper()
	d := &familyDAO{t: t, issueContext: ctx, wantIssueCalls: calls}
	t.Cleanup(func() {
		if d.issueCalls != d.wantIssueCalls {
			t.Errorf("IssueFamily DAO calls = %d, want %d", d.issueCalls, d.wantIssueCalls)
		}
	})
	return d
}

func (d *familyDAO) IssueFamily(ctx context.Context, issue store.OAuthFamilyIssue) error {
	d.t.Helper()
	d.issueCalls++
	if d.issueCalls > d.wantIssueCalls || ctx != d.issueContext {
		d.t.Fatalf("unexpected IssueFamily call %d or context: %v", d.issueCalls, ctx)
	}
	d.issued = true
	d.issue = issue
	return d.issueErr
}
func (d *familyDAO) AuthenticateAccess(_ context.Context, hash []byte, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	if !d.allowAuthentication {
		d.t.Fatal("unexpected AuthenticateAccess call")
	}
	d.authenticated = true
	d.authHash, d.resource, d.scope, d.now = hash, bindings[0].Resource, bindings[0].Scope, now
	return d.identity, d.authErr
}
func (d *familyDAO) LockAccess(context.Context, model.Principal, []store.OAuthBinding, time.Time) error {
	d.t.Fatal("unexpected LockAccess")
	return nil
}
func (d *familyDAO) ReadAccess(context.Context, model.Principal, []store.OAuthBinding, time.Time) error {
	d.t.Fatal("unexpected ReadAccess")
	return nil
}
func (d *familyDAO) RevokeFamily(context.Context, string, time.Time) (bool, error) {
	d.t.Fatal("unexpected RevokeFamily call")
	return false, nil
}
func (d *familyDAO) InspectGrant(context.Context, string, bool) (store.OAuthGrant, error) {
	d.t.Fatal("unexpected InspectGrant call")
	return store.OAuthGrant{}, nil
}
func (d *familyDAO) ActiveClientReferences(context.Context, string, time.Time) (bool, error) {
	d.t.Fatal("unexpected ActiveClientReferences call")
	return false, nil
}
func input() IssueInput {
	return IssueInput{UserID: uuid.NewString(), ClientID: "client", Resource: "https://daynight.example/mcp", ClientSnapshot: []byte(`{"client_name":"Example"}`)}
}

func TestIssueFamilyUsesHashesAndOneTransaction(t *testing.T) {
	type contextKey struct{}
	ctx := context.WithValue(t.Context(), contextKey{}, "caller")
	dao := newIssuanceDAO(t, ctx, 1)
	in := input()
	now := time.Date(2026, 11, 6, 8, 1, 2, 123456789, time.FixedZone("test", 3600))
	issued, err := IssueFamily(ctx, dao, in, now)
	if err != nil {
		t.Fatal(err)
	}
	if !dao.issued || issued.Grant.ID == "" || issued.AccessID == "" || issued.Grant.ID == issued.AccessID || issued.Grant.UserID != in.UserID || issued.Grant.ClientID != in.ClientID || issued.Grant.Resource != in.Resource || issued.Grant.Scope != Scope {
		t.Fatalf("family mismatch: %+v", issued.Grant)
	}
	created := now.UTC().Truncate(time.Microsecond)
	if issued.Grant.CreatedAt != created || !issued.Grant.ExpiresAt.Equal(created.Add(GrantLifetime)) || !issued.AccessExpiresAt.Equal(created.Add(AccessLifetime)) {
		t.Fatal("incorrect lifetime or timestamp precision")
	}
	if !secret.Valid(issued.AccessToken, model.OAuthAccessPrefix) || !secret.Valid(issued.RefreshToken, RefreshPrefix) || issued.AccessToken == issued.RefreshToken {
		t.Fatal("invalid or shared secrets")
	}
	wantIssue := store.OAuthFamilyIssue{
		Grant:    store.OAuthGrant{ID: issued.Grant.ID, UserID: in.UserID, ClientID: in.ClientID, Resource: in.Resource, Scope: Scope, ClientSnapshot: []byte(`{"client_name":"Example"}`), CreatedAt: created, ExpiresAt: created.Add(GrantLifetime)},
		AccessID: issued.AccessID, AccessHash: secret.Hash(issued.AccessToken), RefreshHash: secret.Hash(issued.RefreshToken), AccessExpiresAt: created.Add(AccessLifetime),
	}
	if !reflect.DeepEqual(dao.issue, wantIssue) {
		t.Fatalf("transaction material = %+v, want %+v", dao.issue, wantIssue)
	}
	in.ClientSnapshot[0] = '['
	if string(issued.Grant.ClientSnapshot) != `{"client_name":"Example"}` {
		t.Fatal("client snapshot retained caller's mutable buffer")
	}
}

func TestIssueFamilyRejectsInvalidInputsAndSuppressesSecretsOnError(t *testing.T) {
	cases := []struct {
		name string
		edit func(*IssueInput)
		now  time.Time
	}{
		{"zero user", func(i *IssueInput) { i.UserID = uuid.Nil.String() }, time.Now()},
		{"bad user", func(i *IssueInput) { i.UserID = "bad" }, time.Now()},
		{"missing client", func(i *IssueInput) { i.ClientID = "" }, time.Now()},
		{"nul client", func(i *IssueInput) { i.ClientID = "bad\x00client" }, time.Now()},
		{"wrong resource", func(i *IssueInput) { i.Resource = "https://daynight.example/api" }, time.Now()},
		{"resource query", func(i *IssueInput) { i.Resource += "?x=1" }, time.Now()},
		{"invalid snapshot", func(i *IssueInput) { i.ClientSnapshot = []byte(`{`) }, time.Now()},
		{"nonobject snapshot", func(i *IssueInput) { i.ClientSnapshot = []byte(`null`) }, time.Now()},
		{"zero clock", func(*IssueInput) {}, time.Time{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := t.Context()
			dao := newIssuanceDAO(t, ctx, 0)
			in := input()
			tc.edit(&in)
			issued, err := IssueFamily(ctx, dao, in, tc.now)
			if err == nil || dao.issued || issued.AccessToken != "" || issued.RefreshToken != "" {
				t.Fatalf("accepted invalid input: %+v, %v", issued, err)
			}
		})
	}
	failure := errors.New("storage failure")
	type contextKey struct{}
	ctx := context.WithValue(t.Context(), contextKey{}, "failed caller")
	dao := newIssuanceDAO(t, ctx, 1)
	dao.issueErr = failure
	in, now := input(), time.Date(2026, 11, 6, 8, 1, 2, 123456789, time.FixedZone("test", 3600))
	wantSnapshot := bytes.Clone(in.ClientSnapshot)
	issued, err := IssueFamily(ctx, dao, in, now)
	if !errors.Is(err, failure) || !reflect.DeepEqual(issued, IssuedFamily{}) {
		t.Fatal("failed issuance returned material or hid failure")
	}
	created := now.UTC().Truncate(time.Microsecond)
	wantGrant := store.OAuthGrant{ID: dao.issue.Grant.ID, UserID: in.UserID, ClientID: in.ClientID, Resource: in.Resource, Scope: Scope, ClientSnapshot: wantSnapshot, CreatedAt: created, ExpiresAt: created.Add(GrantLifetime)}
	if !reflect.DeepEqual(dao.issue.Grant, wantGrant) || dao.issue.Grant.ID == "" || dao.issue.AccessID == "" || dao.issue.AccessID == dao.issue.Grant.ID || len(dao.issue.AccessHash) != 32 || len(dao.issue.RefreshHash) != 32 || dao.issue.AccessExpiresAt != created.Add(AccessLifetime) {
		t.Fatalf("failed issuance changed DAO input: %+v", dao.issue)
	}
}

func TestAuthenticateAccessValidatesTokenAndResource(t *testing.T) {
	now := time.Now()
	token := secret.Random(model.OAuthAccessPrefix)
	identity := store.OAuthAccessIdentity{GrantID: uuid.NewString(), ExpiresAt: time.Now().Add(24 * time.Hour), Principal: model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}}
	dao := &familyDAO{t: t, allowAuthentication: true, identity: identity}
	got, err := AuthenticateAccess(context.Background(), dao, token, "https://daynight.example/mcp", now)
	if err != nil || got != identity || !dao.authenticated || !bytes.Equal(dao.authHash, secret.Hash(token)) || dao.resource != "https://daynight.example/mcp" || dao.scope != Scope || !dao.now.Equal(now.UTC().Truncate(time.Microsecond)) {
		t.Fatalf("authentication: %+v %v", got, err)
	}
	for _, bad := range []string{"", secret.Random(RefreshPrefix), token + "!"} {
		dao.authenticated = false
		if _, err := AuthenticateAccess(context.Background(), dao, bad, "https://daynight.example/mcp", now); err == nil || dao.authenticated {
			t.Fatal("invalid access token reached store")
		}
	}
	dao.authenticated = false
	if _, err := AuthenticateAccess(context.Background(), dao, token, "https://daynight.example/other", now); err == nil || dao.authenticated {
		t.Fatal("invalid resource reached store")
	}
	dao.authErr = model.ErrNotFound
	if _, err := AuthenticateAccess(context.Background(), dao, token, "https://daynight.example/mcp", now); err == nil {
		t.Fatal("missing token was accepted")
	}
	failure := errors.New("database failure")
	dao.authErr = failure
	if _, err := AuthenticateAccess(context.Background(), dao, token, "https://daynight.example/mcp", now); !errors.Is(err, failure) {
		t.Fatal("database failure was concealed")
	}
	dao.authErr = nil
	dao.identity = store.OAuthAccessIdentity{}
	if _, err := AuthenticateAccess(context.Background(), dao, token, "https://daynight.example/mcp", now); err == nil {
		t.Fatal("empty identity was accepted")
	}
}

type unexpectedFamilyOperations struct {
	store.CredentialFamilyDAO
	t *testing.T
}

func (d unexpectedFamilyOperations) IssueFamily(context.Context, store.OAuthFamilyIssue) error {
	d.t.Fatal("unexpected IssueFamily call")
	return nil
}

func (d unexpectedFamilyOperations) RevokeFamily(context.Context, string, time.Time) (bool, error) {
	d.t.Fatal("unexpected RevokeFamily call")
	return false, nil
}

func (d unexpectedFamilyOperations) InspectGrant(context.Context, string, bool) (store.OAuthGrant, error) {
	d.t.Fatal("unexpected InspectGrant call")
	return store.OAuthGrant{}, nil
}

func (d unexpectedFamilyOperations) ActiveClientReferences(context.Context, string, time.Time) (bool, error) {
	d.t.Fatal("unexpected ActiveClientReferences call")
	return false, nil
}

type authenticationReader struct {
	store.CredentialFamilyDAO
	t           *testing.T
	context     context.Context
	hash        []byte
	resource    string
	scope       string
	now         time.Time
	identity    store.OAuthAccessIdentity
	err         error
	wantCalls   int
	actualCalls int
}

func newAuthenticationReader(t *testing.T, wantCalls int) *authenticationReader {
	t.Helper()
	d := &authenticationReader{CredentialFamilyDAO: unexpectedFamilyOperations{t: t}, t: t, wantCalls: wantCalls}
	t.Cleanup(func() {
		if d.actualCalls != d.wantCalls {
			t.Errorf("authentication DAO calls = %d, want %d", d.actualCalls, d.wantCalls)
		}
	})
	return d
}

func (d *authenticationReader) AuthenticateAccess(ctx context.Context, hash []byte, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	d.t.Helper()
	d.actualCalls++
	if d.actualCalls > d.wantCalls {
		d.t.Errorf("unexpected authentication DAO call %d", d.actualCalls)
		return store.OAuthAccessIdentity{}, nil
	}
	if ctx != d.context || !bytes.Equal(hash, d.hash) || len(bindings) != 1 || bindings[0] != (store.OAuthBinding{Resource: d.resource, Scope: d.scope}) || now != d.now {
		d.t.Errorf("authentication DAO arguments: context=%v hash=%x resource=%q scope=%q now=%v; want context=%v hash=%x resource=%q scope=%q now=%v", ctx, hash, bindings[0].Resource, bindings[0].Scope, now, d.context, d.hash, d.resource, d.scope, d.now)
	}
	return d.identity, d.err
}

func TestAuthenticateAccessPreservesReaderInputsAndResults(t *testing.T) {
	type contextKey struct{}
	ctx, cancel := context.WithCancel(context.WithValue(context.Background(), contextKey{}, "caller"))
	defer cancel()
	token := secret.Random(model.OAuthAccessPrefix)
	const resource = "https://daynight.example/mcp"
	now := time.Date(2026, 11, 6, 8, 1, 2, 123456789, time.FixedZone("test", 3600))
	wantTime := time.Date(2026, 11, 6, 7, 1, 2, 123456000, time.UTC)
	identity := store.OAuthAccessIdentity{GrantID: uuid.NewString(), ExpiresAt: time.Now().Add(24 * time.Hour), Principal: model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}}
	failure := errors.New("authentication storage failed")
	for _, tc := range []struct {
		name     string
		identity store.OAuthAccessIdentity
		err      error
	}{
		{name: "identity", identity: identity},
		{name: "storage failure", err: failure},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := newAuthenticationReader(t, 1)
			dao.context, dao.hash, dao.resource, dao.scope, dao.now = ctx, secret.Hash(token), resource, Scope, wantTime
			dao.identity, dao.err = tc.identity, tc.err
			got, err := AuthenticateAccess(ctx, dao, token, resource, now)
			if got != tc.identity || err != tc.err {
				t.Fatalf("authentication = (%+v, %v), want (%+v, %v)", got, err, tc.identity, tc.err)
			}
		})
	}
	t.Run("malformed token", func(t *testing.T) {
		dao := newAuthenticationReader(t, 0)
		got, err := AuthenticateAccess(ctx, dao, "not-an-access-token", resource, now)
		var fault *model.Fault
		if got != (store.OAuthAccessIdentity{}) || !errors.As(err, &fault) || fault.Code != "unauthenticated" {
			t.Fatalf("malformed authentication = (%+v, %v), want zero identity and refusal", got, err)
		}
	})
}
