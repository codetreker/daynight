package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	uniauth "github.com/codetreker/uniauth/sdk/go"
	"github.com/google/uuid"
)

type identityReply struct {
	status int
	body   any
}

type identityFixture struct {
	identity *Identity
	database *store.Store
	now      time.Time
	calls    atomic.Int32
	replies  map[string]identityReply
	before   func(*http.Request)
}

// This server exercises the SDK transport boundary; upstream integration is separate.
func newIdentityFixture(t *testing.T) *identityFixture {
	t.Helper()
	database, err := store.Open(context.Background(), serviceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(database.Close)
	fixture := &identityFixture{database: database, now: time.Date(2026, 10, 22, 12, 0, 0, 0, time.UTC), replies: map[string]identityReply{}}
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fixture.calls.Add(1)
		appID, secret, ok := r.BasicAuth()
		if r.Method != http.MethodPost || r.URL.Path != "/auth/result" || !ok || appID != "test-app" || secret != "test-secret" {
			t.Errorf("unexpected gateway request: %s %s, authenticated=%v", r.Method, r.URL.Path, ok)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var input struct {
			Code string `json:"code"`
		}
		if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
			t.Errorf("decode result request: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if fixture.before != nil {
			fixture.before(r)
		}
		reply, exists := fixture.replies[input.Code]
		if !exists {
			reply = identityReply{status: http.StatusOK, body: identityProfile("identity-" + input.Code)}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-ID", "gateway-request")
		w.WriteHeader(reply.status)
		if err := json.NewEncoder(w).Encode(reply.body); err != nil && r.Context().Err() == nil {
			t.Errorf("encode gateway response: %v", err)
		}
	}))
	t.Cleanup(gateway.Close)
	client, err := uniauth.New(uniauth.Config{BaseURL: gateway.URL, AppID: "test-app", AppSecret: "test-secret", AllowLoopbackHTTP: true, HTTPClient: gateway.Client()})
	if err != nil {
		t.Fatal(err)
	}
	fixture.identity = NewIdentity(database, client, "http://127.0.0.1:8080/api/v1/auth/callback")
	fixture.identity.now = func() time.Time { return fixture.now }
	return fixture
}

func identityProfile(id string) map[string]any {
	return map[string]any{"provider": "microsoft", "id": id, "email": "shared@example.com", "email_verified": false, "name": "Display name", "avatar_url": nil, "origin": map[string]any{}}
}

func startIdentityLogin(t *testing.T, fixture *identityFixture, returnPath string) LoginStart {
	t.Helper()
	start, err := fixture.identity.StartLogin(context.Background(), "microsoft", returnPath)
	if err != nil {
		t.Fatal(err)
	}
	return start
}

func identityQuery(start LoginStart, code string) url.Values {
	return url.Values{"state": {start.State}, "code": {code}}
}

func completeIdentityLogin(t *testing.T, fixture *identityFixture, code string) LoginCompletion {
	t.Helper()
	start := startIdentityLogin(t, fixture, "/projects?view=graph")
	result, err := fixture.identity.CompleteLogin(context.Background(), identityQuery(start, code), start.BrowserBinding)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func identityPrincipal(t *testing.T, fixture *identityFixture, completion LoginCompletion) core.Principal {
	t.Helper()
	principal, err := fixture.identity.Authenticate(context.Background(), core.SessionCredential, completion.Secret)
	if err != nil {
		t.Fatal(err)
	}
	return principal
}

func requireIdentityOperationalError(t *testing.T, err error) {
	t.Helper()
	var fault *Fault
	var databaseError *store.Error
	if err == nil || errors.As(err, &fault) || !errors.As(err, &databaseError) || databaseError.Unwrap() == nil {
		t.Fatalf("expected retained database failure, got %#v", err)
	}
}

func TestIdentityStartLogin(t *testing.T) {
	fixture := newIdentityFixture(t)
	for _, provider := range []string{"microsoft", "google", "github"} {
		start, err := fixture.identity.StartLogin(context.Background(), provider, "")
		if err != nil {
			t.Fatal(err)
		}
		u, err := url.Parse(start.AuthorizationURL)
		if err != nil || u.Path != "/auth/authorize" || u.Query().Get("provider") != provider || u.Query().Get("app_id") != "test-app" || u.Query().Get("state") != start.State || u.Query().Get("redirect_uri") != fixture.identity.CallbackURL() {
			t.Fatalf("authorization request: %s, %v", start.AuthorizationURL, err)
		}
		if !validSecret(start.State, "") || !validSecret(start.BrowserBinding, "") || start.State == start.BrowserBinding || !start.ExpiresAt.Equal(fixture.now.Add(LoginLifetime)) {
			t.Fatalf("login material: %#v", start)
		}
		if _, err := uuid.Parse(start.ID); err != nil {
			t.Fatal(err)
		}
		var stateHash, bindingHash []byte
		var storedProvider, returnPath string
		if err := fixture.database.Pool.QueryRow(context.Background(), "SELECT state_hash,browser_binding_hash,provider,return_path FROM login_transactions WHERE id=$1", start.ID).Scan(&stateHash, &bindingHash, &storedProvider, &returnPath); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(stateHash, secretHash(start.State)) || !bytes.Equal(bindingHash, secretHash(start.BrowserBinding)) || storedProvider != provider || returnPath != "/projects" {
			t.Fatalf("pending login did not persist hashes and default return path: %s %s", storedProvider, returnPath)
		}
	}
	if fixture.calls.Load() != 0 {
		t.Fatal("starting login must not retrieve an identity")
	}
}

func TestIdentityStartLoginValidation(t *testing.T) {
	fixture := newIdentityFixture(t)
	for _, provider := range []string{"", "Microsoft", "oidc", "github\x00"} {
		_, err := fixture.identity.StartLogin(context.Background(), provider, "/")
		requireFault(t, err, "invalid_input")
	}
	for _, path := range []string{"https://evil.example/path", "//evil.example", "relative", "/\\evil", "/line\rbreak", "/line\nbreak", "/bad\x00", "/bad\xff", "/%5Cevil", "/%0Dheader", "/%00bad", "/%2fexample.com", "/api/v1/auth/login", "/api/v1/%61uth/callback", "/login", "/login?returnPath=/projects", "/login/child", "/other/../login", "/%6cogin", "/%zz"} {
		_, err := fixture.identity.StartLogin(context.Background(), "microsoft", path)
		requireFault(t, err, "invalid_input")
	}
	for _, path := range []string{"/", "/projects", "/projects/abc?view=graph#tasks", "/%E4%B8%AD%E6%96%87", "/login-help"} {
		if _, err := fixture.identity.StartLogin(context.Background(), "microsoft", path); err != nil {
			t.Fatalf("valid return path %q: %v", path, err)
		}
	}
	fixture.identity.callbackURL = "ftp://not-http.example/callback"
	if _, err := fixture.identity.StartLogin(context.Background(), "microsoft", "/"); err == nil {
		t.Fatal("SDK callback configuration failure was hidden")
	}
}

func TestIdentityMalformedCallbacksDoNotConsumeLogin(t *testing.T) {
	fixture := newIdentityFixture(t)
	cases := map[string]func(LoginStart) (url.Values, string){
		"missing state": func(s LoginStart) (url.Values, string) { return url.Values{"code": {"valid"}}, s.BrowserBinding },
		"duplicate state": func(s LoginStart) (url.Values, string) {
			return url.Values{"state": {s.State, s.State}, "code": {"valid"}}, s.BrowserBinding
		},
		"invalid state": func(s LoginStart) (url.Values, string) {
			return url.Values{"state": {"!"}, "code": {"valid"}}, s.BrowserBinding
		},
		"invalid binding": func(s LoginStart) (url.Values, string) { return identityQuery(s, "valid"), "!" },
		"wrong binding":   func(s LoginStart) (url.Values, string) { return identityQuery(s, "valid"), randomSecret("") },
		"unknown state": func(s LoginStart) (url.Values, string) {
			return url.Values{"state": {randomSecret("")}, "code": {"valid"}}, s.BrowserBinding
		},
		"missing result": func(s LoginStart) (url.Values, string) { return url.Values{"state": {s.State}}, s.BrowserBinding },
		"duplicate code": func(s LoginStart) (url.Values, string) {
			return url.Values{"state": {s.State}, "code": {"a", "b"}}, s.BrowserBinding
		},
		"empty code": func(s LoginStart) (url.Values, string) { return identityQuery(s, ""), s.BrowserBinding },
		"conflicting result": func(s LoginStart) (url.Values, string) {
			return url.Values{"state": {s.State}, "code": {"valid"}, "error": {"provider_failed"}}, s.BrowserBinding
		},
		"unknown gateway failure": func(s LoginStart) (url.Values, string) {
			return url.Values{"state": {s.State}, "error": {"unknown"}}, s.BrowserBinding
		},
	}
	for name, query := range cases {
		t.Run(name, func(t *testing.T) {
			start := startIdentityLogin(t, fixture, "/tasks")
			values, binding := query(start)
			before := fixture.calls.Load()
			result, err := fixture.identity.CompleteLogin(context.Background(), values, binding)
			requireFault(t, err, "unauthenticated")
			if result.LoginID != "" || fixture.calls.Load() != before {
				t.Fatalf("invalid callback crossed admission boundary: %#v", result)
			}
			result, err = fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "valid"), start.BrowserBinding)
			if err != nil || result.LoginID != start.ID || result.ReturnPath != "/tasks" {
				t.Fatalf("valid callback after rejected callback: %#v, %v", result, err)
			}
		})
	}
}

func TestIdentityExpiredAndConsumedCallbacks(t *testing.T) {
	fixture := newIdentityFixture(t)
	start := startIdentityLogin(t, fixture, "/")
	fixture.now = start.ExpiresAt
	_, err := fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "expired"), start.BrowserBinding)
	requireFault(t, err, "unauthenticated")
	if fixture.calls.Load() != 0 {
		t.Fatal("expired login reached gateway")
	}
	for _, code := range []string{"provider_denied", "provider_failed", "capacity_exceeded"} {
		start := startIdentityLogin(t, fixture, "/tasks")
		result, err := fixture.identity.CompleteLogin(context.Background(), url.Values{"state": {start.State}, "error": {code}}, start.BrowserBinding)
		fault := requireFault(t, err, "unauthenticated")
		var callbackErr *uniauth.CallbackError
		if !errors.As(fault, &callbackErr) || callbackErr.Code != code || result.LoginID != start.ID || result.ReturnPath != "/tasks" {
			t.Fatalf("gateway callback failure: %#v, %v", result, err)
		}
		_, err = fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "retry"), start.BrowserBinding)
		requireFault(t, err, "unauthenticated")
	}
	if fixture.calls.Load() != 0 {
		t.Fatal("denied or replayed callback reached gateway")
	}
}

func TestIdentityCompletionAndSession(t *testing.T) {
	fixture := newIdentityFixture(t)
	start := startIdentityLogin(t, fixture, "/tasks?view=graph#active")
	result, err := fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "alice"), start.BrowserBinding)
	if err != nil {
		t.Fatal(err)
	}
	if result.LoginID != start.ID || result.ReturnPath != "/tasks?view=graph#active" || result.User.UniAuthID != "identity-alice" || result.User.Email == nil || *result.User.Email != "shared@example.com" || result.User.EmailVerified == nil || *result.User.EmailVerified || result.User.AvatarURL != nil || result.User.Name == nil || *result.User.Name != "Display name" {
		t.Fatalf("identity profile or return path lost: %#v", result)
	}
	if !validSecret(result.Secret, "dnst_") || result.Session.UserID != result.User.ID || !result.Session.CreatedAt.Equal(fixture.now) || !result.Session.ExpiresAt.Equal(fixture.now.Add(SessionLifetime)) || !bytes.Equal(result.Session.TokenHash, secretHash(result.Secret)) {
		t.Fatalf("issued session: %#v", result.Session)
	}
	principal := identityPrincipal(t, fixture, result)
	if principal.UserID != result.User.ID || principal.CredentialID != result.Session.ID || principal.Kind != core.SessionCredential {
		t.Fatalf("session principal: %#v", principal)
	}
	user, err := fixture.identity.User(context.Background(), principal)
	if err != nil || !reflect.DeepEqual(user, result.User) {
		t.Fatalf("current user: %#v, %v", user, err)
	}
	_, err = fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "alice"), start.BrowserBinding)
	requireFault(t, err, "unauthenticated")
	if fixture.calls.Load() != 1 {
		t.Fatalf("callback was retrieved %d times", fixture.calls.Load())
	}
	fixture.now = result.Session.ExpiresAt
	_, err = fixture.identity.Authenticate(context.Background(), core.SessionCredential, result.Secret)
	requireFault(t, err, "unauthenticated")
}

func TestIdentityRetrieveFailuresConsumeExactlyOnce(t *testing.T) {
	fixture := newIdentityFixture(t)
	fixture.replies["failure"] = identityReply{status: http.StatusServiceUnavailable, body: map[string]any{"error": map[string]any{"code": "unavailable", "message": "Gateway unavailable"}}}
	fixture.replies["malformed"] = identityReply{status: http.StatusOK, body: map[string]any{"provider": "microsoft"}}
	mismatch := identityProfile("mismatched")
	mismatch["provider"] = "google"
	fixture.replies["mismatch"] = identityReply{status: http.StatusOK, body: mismatch}
	for _, code := range []string{"failure", "malformed", "mismatch"} {
		t.Run(code, func(t *testing.T) {
			start := startIdentityLogin(t, fixture, "/retry")
			before := fixture.calls.Load()
			result, err := fixture.identity.CompleteLogin(context.Background(), identityQuery(start, code), start.BrowserBinding)
			if result.LoginID != start.ID || result.ReturnPath != "/retry" || result.Secret != "" || result.User.ID != "" {
				t.Fatalf("failed retrieval issued credentials or lost transaction: %#v", result)
			}
			switch code {
			case "failure":
				var upstream *uniauth.APIError
				if !errors.As(err, &upstream) || upstream.StatusCode != http.StatusServiceUnavailable || upstream.RequestID != "gateway-request" {
					t.Fatalf("upstream failure lost: %v", err)
				}
			case "malformed":
				var protocol *uniauth.ProtocolError
				if !errors.As(err, &protocol) || protocol.Reason != "identity_schema" {
					t.Fatalf("protocol failure lost: %v", err)
				}
			case "mismatch":
				fault := requireFault(t, err, "unauthenticated")
				var protocol *uniauth.ProtocolError
				if !errors.As(fault, &protocol) || protocol.Reason != "provider_mismatch" {
					t.Fatalf("provider mismatch cause: %v", err)
				}
			}
			_, err = fixture.identity.CompleteLogin(context.Background(), identityQuery(start, code), start.BrowserBinding)
			requireFault(t, err, "unauthenticated")
			if fixture.calls.Load() != before+1 {
				t.Fatal("failed one-time retrieval was retried")
			}
		})
	}
}

func TestIdentitySessionCreationFailureRetainsDestination(t *testing.T) {
	for _, destination := range []string{
		"/projects/project/tasks/task/attachments/docs/guide.md?tab=overview#details",
		"/invitations",
		"/device?user_code=ABCD-EFGH",
	} {
		t.Run(destination, func(t *testing.T) {
			fixture := newIdentityFixture(t)
			if _, err := fixture.database.Pool.Exec(context.Background(), `ALTER TABLE sessions ADD CONSTRAINT reject_session CHECK (false)`); err != nil {
				t.Fatal(err)
			}
			start := startIdentityLogin(t, fixture, destination)
			result, err := fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "session-failure"), start.BrowserBinding)
			requireIdentityOperationalError(t, err)
			if result.LoginID != start.ID || result.ReturnPath != destination {
				t.Fatal("session creation failure lost its consumed login or validated destination")
			}
			if result.Secret != "" || result.User.ID != "" || !reflect.DeepEqual(result.Session, core.Session{}) {
				t.Fatal("session creation failure exposed unissued credentials")
			}
			var logins, users, sessions int
			if err := fixture.database.Pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM login_transactions), (SELECT count(*) FROM users), (SELECT count(*) FROM sessions)`).Scan(&logins, &users, &sessions); err != nil || logins != 0 || users != 0 || sessions != 0 {
				t.Fatalf("session failure did not preserve consumed login and atomic identity state: %d %d %d, %v", logins, users, sessions, err)
			}
			_, err = fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "session-failure"), start.BrowserBinding)
			requireFault(t, err, "unauthenticated")
			if fixture.calls.Load() != 1 {
				t.Fatal("session failure replay retrieved the one-time identity again")
			}
		})
	}
}

func TestIdentityConcurrentCallbackClaims(t *testing.T) {
	fixture := newIdentityFixture(t)
	start := startIdentityLogin(t, fixture, "/")
	launch := make(chan struct{})
	errorsFound := make(chan error, 8)
	var workers sync.WaitGroup
	for range 8 {
		workers.Go(func() {
			<-launch
			_, err := fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "concurrent"), start.BrowserBinding)
			errorsFound <- err
		})
	}
	close(launch)
	workers.Wait()
	close(errorsFound)
	succeeded := 0
	for err := range errorsFound {
		if err == nil {
			succeeded++
		} else {
			requireFault(t, err, "unauthenticated")
		}
	}
	if succeeded != 1 || fixture.calls.Load() != 1 {
		t.Fatalf("concurrent callback claims: successes=%d, retrievals=%d", succeeded, fixture.calls.Load())
	}
	var sessions int
	if err := fixture.database.Pool.QueryRow(context.Background(), "SELECT count(*) FROM sessions").Scan(&sessions); err != nil || sessions != 1 {
		t.Fatalf("callback created %d sessions: %v", sessions, err)
	}
}

func TestIdentityStableIDAndNullableProfile(t *testing.T) {
	fixture := newIdentityFixture(t)
	first := completeIdentityLogin(t, fixture, "first")
	second := completeIdentityLogin(t, fixture, "second")
	if first.User.ID == second.User.ID || first.User.UniAuthID == second.User.UniAuthID || *first.User.Email != *second.User.Email {
		t.Fatalf("same-email external identities were merged: %#v, %#v", first.User, second.User)
	}
	profile := identityProfile(first.User.UniAuthID)
	profile["email"], profile["email_verified"], profile["name"], profile["avatar_url"] = nil, nil, nil, nil
	fixture.replies["updated"] = identityReply{status: http.StatusOK, body: profile}
	fixture.now = fixture.now.Add(time.Minute)
	updated := completeIdentityLogin(t, fixture, "updated")
	if updated.User.ID != first.User.ID || updated.User.Email != nil || updated.User.EmailVerified != nil || updated.User.Name != nil || updated.User.AvatarURL != nil || !updated.User.CreatedAt.Equal(first.User.CreatedAt) || !updated.User.UpdatedAt.Equal(fixture.now) || updated.Session.ID == first.Session.ID {
		t.Fatalf("stable identity update or nullable fields lost: %#v", updated)
	}
}

func TestIdentityConcurrentIdentityCreation(t *testing.T) {
	fixture := newIdentityFixture(t)
	const count = 8
	starts := make([]LoginStart, count)
	for index := range count {
		starts[index] = startIdentityLogin(t, fixture, "/")
	}
	results := make(chan LoginCompletion, count)
	errorsFound := make(chan error, count)
	launch := make(chan struct{})
	var workers sync.WaitGroup
	for _, start := range starts {
		workers.Go(func() {
			<-launch
			result, err := fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "shared"), start.BrowserBinding)
			results <- result
			errorsFound <- err
		})
	}
	close(launch)
	workers.Wait()
	close(results)
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatal(err)
		}
	}
	userID := ""
	sessions := map[string]bool{}
	for result := range results {
		if userID == "" {
			userID = result.User.ID
		}
		if result.User.ID != userID || sessions[result.Session.ID] {
			t.Fatalf("concurrent identity was duplicated or session reused: %#v", result)
		}
		sessions[result.Session.ID] = true
	}
	var users, storedSessions int
	if err := fixture.database.Pool.QueryRow(context.Background(), "SELECT (SELECT count(*) FROM users), (SELECT count(*) FROM sessions)").Scan(&users, &storedSessions); err != nil || users != 1 || storedSessions != count || fixture.calls.Load() != count {
		t.Fatalf("concurrent identity persistence: users=%d sessions=%d retrievals=%d, %v", users, storedSessions, fixture.calls.Load(), err)
	}
}

func TestIdentityPATLifecycleAndOwnerIsolation(t *testing.T) {
	fixture := newIdentityFixture(t)
	ctx := context.Background()
	alice := identityPrincipal(t, fixture, completeIdentityLogin(t, fixture, "alice"))
	bob := identityPrincipal(t, fixture, completeIdentityLogin(t, fixture, "bob"))
	minted, err := fixture.identity.CreatePAT(ctx, alice, CreatePAT{Name: " Build agent ", ExpiresAt: tokenExpiryAt(fixture.now.Add(30 * 24 * time.Hour))})
	if err != nil {
		t.Fatal(err)
	}
	if !validSecret(minted.Secret, "dnpat_") || minted.Credential.UserID != alice.UserID || minted.Credential.Name != " Build agent " || !minted.Credential.CreatedAt.Equal(fixture.now) || !minted.Credential.ExpiresAt.Equal(fixture.now.Add(30*24*time.Hour)) || !bytes.Equal(minted.Credential.TokenHash, secretHash(minted.Secret)) {
		t.Fatalf("issued PAT: %#v", minted)
	}
	pat, err := fixture.identity.Authenticate(ctx, core.PATCredential, minted.Secret)
	if err != nil || pat.UserID != alice.UserID || pat.CredentialID != minted.Credential.ID || pat.Kind != core.PATCredential {
		t.Fatalf("PAT principal: %#v, %v", pat, err)
	}
	for _, principal := range []core.Principal{alice, bob} {
		listed, err := fixture.identity.ListPATs(ctx, principal)
		if err != nil {
			t.Fatal(err)
		}
		if principal == bob {
			if len(listed) != 0 {
				t.Fatalf("another user's token was listed: %#v", listed)
			}
		} else if len(listed) != 1 || listed[0].ID != minted.Credential.ID || listed[0].TokenHash != nil || listed[0].Name != minted.Credential.Name {
			t.Fatalf("PAT listing disclosed hash or lost fields: %#v", listed)
		}
	}
	if err := fixture.identity.RevokePAT(ctx, bob, minted.Credential.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.identity.Authenticate(ctx, core.PATCredential, minted.Secret); err != nil {
		t.Fatalf("another user revoked the PAT: %v", err)
	}
	if err := fixture.identity.RevokePAT(ctx, alice, strings.ToUpper(minted.Credential.ID)); err != nil {
		t.Fatal(err)
	}
	_, err = fixture.identity.Authenticate(ctx, core.PATCredential, minted.Secret)
	requireFault(t, err, "unauthenticated")
	if err := fixture.identity.RevokePAT(ctx, alice, minted.Credential.ID); err != nil {
		t.Fatalf("repeated revoke: %v", err)
	}
	listed, err := fixture.identity.ListPATs(ctx, alice)
	if err != nil || len(listed) != 0 {
		t.Fatalf("revoked PAT remained listed: %#v, %v", listed, err)
	}
}

func TestIdentityPATValidationAndSessionOnlyOperations(t *testing.T) {
	fixture := newIdentityFixture(t)
	ctx := context.Background()
	principal := identityPrincipal(t, fixture, completeIdentityLogin(t, fixture, "alice"))
	for _, name := range []string{"", " \t\n", "bad\x00name", "bad\xffname", strings.Repeat("界", 101)} {
		_, err := fixture.identity.CreatePAT(ctx, principal, CreatePAT{Name: name, ExpiresAt: tokenExpiryAt(fixture.now.Add(24 * time.Hour))})
		requireFault(t, err, "invalid_input")
	}
	for _, days := range []int{-1, 0} {
		_, err := fixture.identity.CreatePAT(ctx, principal, CreatePAT{Name: "Agent", ExpiresAt: tokenExpiryAt(fixture.now.Add(time.Duration(days) * 24 * time.Hour))})
		requireFault(t, err, "invalid_input")
	}
	for _, days := range []int{1, 365, 3650} {
		if _, err := fixture.identity.CreatePAT(ctx, principal, CreatePAT{Name: strings.Repeat("界", 100), ExpiresAt: tokenExpiryAt(fixture.now.Add(time.Duration(days) * 24 * time.Hour))}); err != nil {
			t.Fatalf("valid PAT bounds %d: %v", days, err)
		}
	}
	if err := fixture.identity.RevokePAT(ctx, principal, "invalid-id"); err == nil {
		t.Fatal("invalid revoke ID was accepted")
	} else {
		requireFault(t, err, "invalid_input")
	}
	pat := core.Principal{Kind: core.PATCredential, UserID: principal.UserID, CredentialID: uuid.NewString()}
	_, err := fixture.identity.CreatePAT(ctx, pat, CreatePAT{Name: "Agent", ExpiresAt: tokenExpiryAt(fixture.now.Add(24 * time.Hour))})
	requireFault(t, err, "forbidden")
	_, err = fixture.identity.ListPATs(ctx, pat)
	requireFault(t, err, "forbidden")
	requireFault(t, fixture.identity.RevokePAT(ctx, pat, uuid.NewString()), "forbidden")
	requireFault(t, fixture.identity.Logout(ctx, pat), "forbidden")
	for _, kind := range []core.CredentialKind{core.SessionCredential, core.PATCredential, "unknown"} {
		for _, secret := range []string{"", "wrong", "dnst_" + strings.Repeat("!", 43), "dnpat_" + strings.Repeat("A", 42), "dnst_" + strings.Repeat("A", 43) + "="} {
			_, err := fixture.identity.Authenticate(ctx, kind, secret)
			requireFault(t, err, "unauthenticated")
		}
	}
	_, err = fixture.identity.Authenticate(ctx, "unknown", randomSecret("dnst_"))
	requireFault(t, err, "unauthenticated")
	_, err = fixture.identity.User(ctx, core.Principal{UserID: uuid.NewString()})
	requireFault(t, err, "unauthenticated")
}

func TestIdentityLogoutAndCredentialExpiry(t *testing.T) {
	fixture := newIdentityFixture(t)
	ctx := context.Background()
	login := completeIdentityLogin(t, fixture, "alice")
	principal := identityPrincipal(t, fixture, login)
	pat, err := fixture.identity.CreatePAT(ctx, principal, CreatePAT{Name: "One day", ExpiresAt: tokenExpiryAt(fixture.now.Add(24 * time.Hour))})
	if err != nil {
		t.Fatal(err)
	}
	fixture.now = *pat.Credential.ExpiresAt
	_, err = fixture.identity.Authenticate(ctx, core.PATCredential, pat.Secret)
	requireFault(t, err, "unauthenticated")
	listed, err := fixture.identity.ListPATs(ctx, principal)
	if err != nil || len(listed) != 0 {
		t.Fatalf("expired PAT listed: %#v, %v", listed, err)
	}
	if err := fixture.identity.Logout(ctx, principal); err != nil {
		t.Fatal(err)
	}
	_, err = fixture.identity.Authenticate(ctx, core.SessionCredential, login.Secret)
	requireFault(t, err, "unauthenticated")
	_, err = fixture.identity.CreatePAT(ctx, principal, CreatePAT{Name: "Stale", ExpiresAt: tokenExpiryAt(fixture.now.Add(24 * time.Hour))})
	requireFault(t, err, "unauthenticated")
	_, err = fixture.identity.ListPATs(ctx, principal)
	requireFault(t, err, "unauthenticated")
	requireFault(t, fixture.identity.RevokePAT(ctx, principal, pat.Credential.ID), "unauthenticated")
	if err := fixture.identity.Logout(ctx, principal); err != nil {
		t.Fatalf("repeated logout: %v", err)
	}
}

func TestIdentityStoreFailuresRemainOperational(t *testing.T) {
	fixture := newIdentityFixture(t)
	ctx := context.Background()
	login := completeIdentityLogin(t, fixture, "alice")
	principal := identityPrincipal(t, fixture, login)
	start := startIdentityLogin(t, fixture, "/")
	fixture.database.Close()
	_, err := fixture.identity.StartLogin(ctx, "microsoft", "/")
	requireIdentityOperationalError(t, err)
	_, err = fixture.identity.CompleteLogin(ctx, identityQuery(start, "alice"), start.BrowserBinding)
	requireIdentityOperationalError(t, err)
	_, err = fixture.identity.Authenticate(ctx, core.SessionCredential, login.Secret)
	requireIdentityOperationalError(t, err)
	_, err = fixture.identity.User(ctx, principal)
	requireIdentityOperationalError(t, err)
	requireIdentityOperationalError(t, fixture.identity.Logout(ctx, principal))
	_, err = fixture.identity.CreatePAT(ctx, principal, CreatePAT{Name: "Agent", ExpiresAt: tokenExpiryAt(fixture.now.Add(24 * time.Hour))})
	requireIdentityOperationalError(t, err)
	_, err = fixture.identity.ListPATs(ctx, principal)
	requireIdentityOperationalError(t, err)
	requireIdentityOperationalError(t, fixture.identity.RevokePAT(ctx, principal, uuid.NewString()))
}

func TestIdentitySessionPersistenceFailureDoesNotIssueSecret(t *testing.T) {
	fixture := newIdentityFixture(t)
	start := startIdentityLogin(t, fixture, "/")
	fixture.before = func(*http.Request) { fixture.database.Close() }
	result, err := fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "alice"), start.BrowserBinding)
	requireIdentityOperationalError(t, err)
	if result.LoginID != start.ID || result.Secret != "" || result.User.ID != "" || result.Session.ID != "" {
		t.Fatalf("persistence failure issued credentials: %#v", result)
	}
}

func TestIdentityCancellationIsPreserved(t *testing.T) {
	fixture := newIdentityFixture(t)
	start := startIdentityLogin(t, fixture, "/")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := fixture.identity.StartLogin(ctx, "microsoft", "/")
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("start cancellation was hidden: %v", err)
	}
	_, err = fixture.identity.CompleteLogin(ctx, identityQuery(start, "alice"), start.BrowserBinding)
	if !errors.Is(err, context.Canceled) || fixture.calls.Load() != 0 {
		t.Fatalf("callback cancellation was hidden or reached gateway: %v", err)
	}
	if _, err := fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "alice"), start.BrowserBinding); err != nil {
		t.Fatalf("cancelled admission consumed login: %v", err)
	}
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	entered := make(chan struct{})
	release := make(chan struct{})
	defer close(release)
	fixture.before = func(*http.Request) {
		close(entered)
		<-release
	}
	start = startIdentityLogin(t, fixture, "/")
	result := make(chan error, 1)
	go func() {
		_, err := fixture.identity.CompleteLogin(ctx, identityQuery(start, "cancelled"), start.BrowserBinding)
		result <- err
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("gateway request did not start")
	}
	cancel()
	select {
	case err := <-result:
		var requestErr *uniauth.RequestError
		if !errors.Is(err, context.Canceled) || !errors.As(err, &requestErr) {
			t.Fatalf("retrieval cancellation cause lost: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cancelled retrieval did not return")
	}
	_, err = fixture.identity.CompleteLogin(context.Background(), identityQuery(start, "retry"), start.BrowserBinding)
	requireFault(t, err, "unauthenticated")
	if fixture.calls.Load() != 2 {
		t.Fatalf("cancelled result retrieval was retried: %d", fixture.calls.Load())
	}
}

func TestIdentityConfiguredCallbackReturnPath(t *testing.T) {
	fixture := newIdentityFixture(t)
	fixture.identity.callbackURL = "http://daynight.test:8787/auth/callback"
	for _, returnPath := range []string{"/auth/callback", "/auth/callback?code=value", "/auth/callback/child", "/other/../auth/callback", "/auth/%63allback", "/api/v1/auth/login"} {
		_, err := fixture.identity.StartLogin(context.Background(), "microsoft", returnPath)
		requireFault(t, err, "invalid_input")
	}
	start := startIdentityLogin(t, fixture, "/account")
	authorization, err := url.Parse(start.AuthorizationURL)
	if err != nil || authorization.Query().Get("redirect_uri") != fixture.identity.callbackURL {
		t.Fatalf("configured callback changed: %v %v", authorization, err)
	}
	var count int
	if err := fixture.database.Pool.QueryRow(context.Background(), "SELECT count(*) FROM login_transactions").Scan(&count); err != nil || count != 1 {
		t.Fatalf("rejected loop paths created pending state: %d %v", count, err)
	}
	fixture.identity.callbackURL = "https://%zz"
	if fixture.identity.validReturnPath("/") {
		t.Fatal("invalid configured callback accepted")
	}
}

type identityProviderTransport func(*http.Request) (*http.Response, error)

func (transport identityProviderTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestIdentityProviderDiscovery(t *testing.T) {
	var response atomic.Value
	response.Store(identityReply{status: 200, body: map[string]any{"providers": []string{"google", "github"}}})
	const callback = "http://daynight.test:8787/auth/callback"
	var calls atomic.Int32
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		app, secret, ok := request.BasicAuth()
		if request.Method != "POST" || request.URL.Path != "/auth/providers" || !ok || app != "provider-app" || secret != "provider-secret" {
			t.Error("incorrect App-aware discovery request")
		}
		var input struct {
			RedirectURI string `json:"redirect_uri"`
		}
		if err := json.NewDecoder(request.Body).Decode(&input); err != nil || input.RedirectURI != callback {
			t.Error("callback projection changed")
		}
		reply := response.Load().(identityReply)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-ID", "provider-request")
		w.WriteHeader(reply.status)
		_ = json.NewEncoder(w).Encode(reply.body)
	}))
	defer gateway.Close()
	client, err := uniauth.New(uniauth.Config{BaseURL: gateway.URL, AppID: "provider-app", AppSecret: "provider-secret", AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	identity := NewIdentity(nil, client, callback)
	providers, err := identity.Providers(context.Background())
	if err != nil || !reflect.DeepEqual(providers, []string{"google", "github"}) {
		t.Fatalf("provider intersection: %v %v", providers, err)
	}
	response.Store(identityReply{status: 200, body: map[string]any{"providers": []string{}}})
	providers, err = identity.Providers(context.Background())
	if err != nil || providers == nil || len(providers) != 0 {
		t.Fatalf("empty provider intersection: %v %v", providers, err)
	}
	for _, status := range []int{400, 401, 500, 503} {
		response.Store(identityReply{status: status, body: map[string]any{"error": map[string]string{"code": "upstream_code", "message": "private-upstream-message"}}})
		_, err := identity.Providers(context.Background())
		var failure *IdentityProviderError
		var upstream *uniauth.APIError
		expected := "identity_unavailable"
		if status == 400 || status == 401 {
			expected = "identity_configuration"
		}
		if !errors.As(err, &failure) || failure.Code != expected || !errors.As(err, &upstream) || upstream.StatusCode != status || strings.Contains(err.Error(), "private") {
			t.Fatalf("provider error classification: %v", err)
		}
	}
	response.Store(identityReply{status: 200, body: map[string]any{"providers": nil}})
	_, err = identity.Providers(context.Background())
	var failure *IdentityProviderError
	var protocol *uniauth.ProtocolError
	if !errors.As(err, &failure) || failure.Code != "identity_unavailable" || !errors.As(err, &protocol) {
		t.Fatalf("invalid provider response hidden: %v", err)
	}
	if calls.Load() != 7 {
		t.Fatalf("discovery was retried: %d", calls.Load())
	}
}

func TestIdentityProviderTransportCancellation(t *testing.T) {
	cause := errors.New("private transport cause")
	client, err := uniauth.New(uniauth.Config{BaseURL: "https://uniauth.example", AppID: "provider-app", AppSecret: "provider-secret", HTTPClient: &http.Client{Transport: identityProviderTransport(func(request *http.Request) (*http.Response, error) { return nil, cause })}})
	if err != nil {
		t.Fatal(err)
	}
	identity := NewIdentity(nil, client, "https://daynight.example/auth/callback")
	_, err = identity.Providers(context.Background())
	var failure *IdentityProviderError
	if !errors.Is(err, cause) || !errors.As(err, &failure) || failure.Code != "identity_unavailable" || strings.Contains(err.Error(), "private") {
		t.Fatalf("transport chain: %v", err)
	}
	client, err = uniauth.New(uniauth.Config{BaseURL: "https://uniauth.example", AppID: "provider-app", AppSecret: "provider-secret", HTTPClient: &http.Client{Transport: identityProviderTransport(func(request *http.Request) (*http.Response, error) {
		<-request.Context().Done()
		return nil, request.Context().Err()
	})}})
	if err != nil {
		t.Fatal(err)
	}
	identity = NewIdentity(nil, client, "https://daynight.example/auth/callback")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	_, err = identity.Providers(ctx)
	if !errors.Is(err, context.DeadlineExceeded) || !errors.As(err, &failure) || failure.Code != "identity_timeout" || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("deadline chain: %v", err)
	}
}

func tokenExpiryAt(value time.Time) *time.Time { return &value }
