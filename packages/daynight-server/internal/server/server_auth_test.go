package server

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/task/projection"
	profileprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/profile"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	uniauth "github.com/codetreker/uniauth/sdk/go"
	"github.com/google/uuid"
)

type identityHTTPCall struct {
	name  string
	check func([]any) any
}

type identityHTTPScope struct {
	httpRejectedIdentityDAO
	t          *testing.T
	calls      []identityHTTPCall
	position   int
	plan       *identityHTTPPlan
	completion store.Completion
}

var _ store.IdentityScope = (*identityHTTPScope)(nil)
var _ store.IdentityDAO = (*identityHTTPScope)(nil)
var _ store.PersonalTeamDAO = (*identityHTTPScope)(nil)

func (s *identityHTTPScope) invoke(name string, args ...any) any {
	if s.position == len(s.calls) || s.calls[s.position].name != name {
		unexpectedHTTPCall(s.t, "identity."+name)
	}
	call := s.calls[s.position]
	s.position++
	if name == "UpsertUser" {
		s.plan.upserts.Add(1)
	}
	if name == "InsertSession" {
		s.plan.sessions.Add(1)
	}
	return call.check(args)
}

func (s *identityHTTPScope) IdentityDAO() store.IdentityDAO         { return s }
func (s *identityHTTPScope) PersonalTeamDAO() store.PersonalTeamDAO { return s }
func (s *identityHTTPScope) CredentialFamilyDAO() store.CredentialFamilyDAO {
	unexpectedHTTPCall(s.t, "CredentialFamilyDAO")
	panic("unreachable")
}
func (s httpAuthenticationScope) CredentialFamilyDAO() store.CredentialFamilyDAO {
	unexpectedHTTPCall(s.t, "CredentialFamilyDAO")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) LockProfileCredential(context.Context, model.Principal, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockProfileCredential")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) EnsureUser(context.Context, model.User, time.Time) (model.User, bool, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.EnsureUser")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) PatchUser(context.Context, string, model.UserProfilePatch) (model.User, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.PatchUser")
	panic("unreachable")
}
func (s *identityHTTPScope) AdmitLogin(ctx context.Context, hash []byte, global, browser int) (time.Time, string, error) {
	return s.invoke("AdmitLogin", ctx, hash, global, browser).(time.Time), "", nil
}
func (s *identityHTTPScope) CleanupLoginCredentials(ctx context.Context, databaseNow, appNow time.Time) error {
	s.invoke("CleanupLoginCredentials", ctx, databaseNow, appNow)
	return nil
}
func (s *identityHTTPScope) InsertLogin(ctx context.Context, pending model.LoginTransaction) error {
	s.invoke("InsertLogin", ctx, pending)
	return nil
}
func (s *identityHTTPScope) ConsumeLogin(ctx context.Context, state, binding []byte, now time.Time) (model.LoginTransaction, error) {
	result := s.invoke("ConsumeLogin", ctx, state, binding, now)
	if failure, ok := result.(error); ok {
		return model.LoginTransaction{}, failure
	}
	return identityHTTPCloneLogin(result.(model.LoginTransaction)), nil
}
func (s *identityHTTPScope) UpsertUser(ctx context.Context, user model.User, now time.Time) (model.User, error) {
	return identityHTTPCloneUser(s.invoke("UpsertUser", ctx, user, now).(model.User)), nil
}
func (s *identityHTTPScope) InsertPersonalTeam(ctx context.Context, id, user string, now time.Time) (bool, error) {
	return s.invoke("InsertPersonalTeam", ctx, id, user, now).(bool), nil
}
func (s *identityHTTPScope) InsertPersonalOwner(ctx context.Context, id, user string, now time.Time) error {
	s.invoke("InsertPersonalOwner", ctx, id, user, now)
	return nil
}
func (s *identityHTTPScope) PersonalTeam(ctx context.Context, user string) (store.PersonalTeamFacts, error) {
	return s.invoke("PersonalTeam", ctx, user).(store.PersonalTeamFacts), nil
}
func (s *identityHTTPScope) InsertSession(ctx context.Context, session model.Session) error {
	s.invoke("InsertSession", ctx, session)
	return nil
}
func (s *identityHTTPScope) Authenticate(ctx context.Context, kind model.CredentialKind, hash []byte, now time.Time) (model.Principal, error) {
	result := s.invoke("Authenticate", ctx, kind, hash, now)
	if failure, ok := result.(error); ok {
		return model.Principal{}, failure
	}
	return result.(model.Principal), nil
}
func (s *identityHTTPScope) IdentityUser(ctx context.Context, userID string) (model.User, store.PersonalTeamFacts, error) {
	user := identityHTTPCloneUser(s.invoke("IdentityUser", ctx, userID).(model.User))
	return user, store.PersonalTeamFacts{ID: user.PersonalTeam.ID, MemberCount: 1, OwnerAdminCount: 1}, nil
}
func (s *identityHTTPScope) LockSession(ctx context.Context, principal model.Principal, now time.Time) error {
	s.invoke("LockSession", ctx, principal, now)
	return nil
}
func (s *identityHTTPScope) CleanupCredentials(ctx context.Context, now time.Time) error {
	s.invoke("CleanupCredentials", ctx, now)
	return nil
}
func (s *identityHTTPScope) InsertPAT(ctx context.Context, token model.PersonalAccessToken) error {
	s.invoke("InsertPAT", ctx, token)
	return nil
}
func (s *identityHTTPScope) ListPATs(ctx context.Context, userID string, now time.Time) ([]model.PersonalAccessToken, error) {
	items := slices.Clone(s.invoke("ListPATs", ctx, userID, now).([]model.PersonalAccessToken))
	for i := range items {
		items[i] = identityHTTPClonePAT(items[i])
	}
	return items, nil
}
func (s *identityHTTPScope) DeletePAT(ctx context.Context, userID, tokenID string) error {
	s.invoke("DeletePAT", ctx, userID, tokenID)
	return nil
}
func (s *identityHTTPScope) DeleteSession(ctx context.Context, principal model.Principal) error {
	s.invoke("DeleteSession", ctx, principal)
	return nil
}

// Gateway flows mint random credentials. Captures compare write arguments with
// HTTP cookies; subsequent DAO responses remain independently supplied facts.
type identityHTTPPlan struct {
	t            *testing.T
	mu           sync.Mutex
	scopes       []*identityHTTPScope
	upserts      atomic.Int32
	sessions     atomic.Int32
	aliceClaim   string
	sessionDraft model.Session
}

func newIdentityHTTPPlan(t *testing.T) (*httpTestStore, *identityHTTPPlan) {
	t.Helper()
	p := &identityHTTPPlan{t: t}
	database := newHTTPTestStore(t)
	database.WriteIdentityCall = func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
		p.mu.Lock()
		if len(p.scopes) == 0 {
			p.mu.Unlock()
			unexpectedHTTPCall(t, "WriteIdentity")
		}
		scope := p.scopes[0]
		p.scopes = p.scopes[1:]
		p.mu.Unlock()
		if ctx.Err() != nil {
			unexpectedHTTPCall(t, "canceled identity scope")
		}
		if err := fn(scope); err != nil {
			unexpectedHTTPCall(t, "identity callback error: "+err.Error())
		}
		if scope.position != len(scope.calls) {
			unexpectedHTTPCall(t, "incomplete identity scope")
		}
		return scope.completion, nil
	}
	t.Cleanup(func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if len(p.scopes) != 0 {
			t.Errorf("%d identity scopes were not called", len(p.scopes))
		}
	})
	return database, p
}

func (p *identityHTTPPlan) expect(calls ...identityHTTPCall) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.scopes = append(p.scopes, &identityHTTPScope{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: p.t}, t: p.t, calls: calls, plan: p, completion: store.Completion{Outcome: store.TransactionCommitted}})
}

func identityHTTPCheck(t *testing.T, condition bool, message string) {
	if !condition {
		unexpectedHTTPCall(t, message)
	}
}

func identityHTTPNow(t *testing.T, value time.Time) {
	identityHTTPCheck(t, !value.IsZero() && value.Location() == time.UTC, "identity time must be nonzero UTC")
}

type identityLoginWrite struct {
	mu      sync.Mutex
	pending model.LoginTransaction
}

func (w *identityLoginWrite) value() model.LoginTransaction {
	w.mu.Lock()
	defer w.mu.Unlock()
	return identityHTTPCloneLogin(w.pending)
}

func (p *identityHTTPPlan) start() *identityLoginWrite {
	now := time.Now().UTC().Truncate(time.Microsecond)
	captured := &identityLoginWrite{}
	p.expect(identityHTTPCall{"AdmitLogin", func(args []any) any {
		identityHTTPCheck(p.t, len(args[1].([]byte)) == 32 && args[2].(int) == identitycore.MaxPendingLoginsGlobal && args[3].(int) == identitycore.MaxPendingLoginsPerBrowser, "login admission arguments")
		return now
	}}, identityHTTPCall{"CleanupLoginCredentials", func(args []any) any {
		identityHTTPCheck(p.t, args[1].(time.Time) == now, "login database time")
		identityHTTPNow(p.t, args[2].(time.Time))
		return nil
	}}, identityHTTPCall{"InsertLogin", func(args []any) any {
		pending := args[1].(model.LoginTransaction)
		_, err := uuid.Parse(pending.ID)
		identityHTTPCheck(p.t, err == nil && pending.Provider == "github" && pending.ReturnPath == "/projects?view=tasks" && pending.ExpiresAt == now.Add(identitycore.LoginLifetime) && len(pending.StateHash) == 32 && len(pending.BrowserBindingHash) == 32 && len(pending.ScopeHash) == 32, "login write arguments")
		captured.mu.Lock()
		captured.pending = identityHTTPCloneLogin(pending)
		captured.mu.Unlock()
		return nil
	}})
	return captured
}

func (p *identityHTTPPlan) consume(state, binding string, success bool) {
	p.expect(identityHTTPCall{"ConsumeLogin", func(args []any) any {
		identityHTTPCheck(p.t, bytes.Equal(args[1].([]byte), secret.Hash(state)) && bytes.Equal(args[2].([]byte), secret.Hash(binding)), "callback credential hashes")
		identityHTTPNow(p.t, args[3].(time.Time))
		if !success {
			return model.Unauthenticated(nil)
		}
		return model.LoginTransaction{ID: "90f67eb6-57c7-4af7-8d82-6c18d902198d", Provider: "github", ReturnPath: "/projects?view=tasks", ExpiresAt: time.Now().UTC().Add(time.Hour)}
	}})
}

func identityHTTPUser(persona string) model.User {
	user := model.User{ID: "a50e772d-0dc9-4bde-afef-12d3cbb9f260", PersonalTeam: model.TeamRef{ID: "afe063ed-f3f8-4f70-8f20-af0c6493d4b1", Kind: "personal"}}
	text := func(s string) *string { return &s }
	boolean := func(v bool) *bool { return &v }
	switch persona {
	case "alice":
		user.Name = text("Alice")
		user.Email = text("shared@example.test")
		user.EmailVerified = boolean(true)
		user.AvatarURL = text("https://images.example.test/alice.png")
	case "alice-updated", "alice-null":
		user.Name = text("Alice Updated")
		user.Email = text("refreshed@example.test")
		user.EmailVerified = boolean(false)
		user.AvatarURL = text("https://images.example.test/alice-updated.png")
	case "bob":
		user.ID = "bf84dd53-62bf-4b7e-8476-51c16bbabbd2"
		user.PersonalTeam.ID = "b7fdd87c-b68e-4fe6-9fe4-29e93e3af813"
		user.Name = text("Bob")
		user.Email = text("shared@example.test")
		user.EmailVerified = boolean(true)
		user.AvatarURL = text("https://images.example.test/bob.png")
	default:
		panic("unknown identity persona")
	}
	return user
}

func (p *identityHTTPPlan) complete(persona string) {
	user := identityHTTPUser(persona)
	var teamID string
	calls := []identityHTTPCall{{"UpsertUser", func(args []any) any {
		draft := args[1].(model.User)
		identityHTTPNow(p.t, args[2].(time.Time))
		actual, want := profileprotocol.FromUser(draft), profileprotocol.FromUser(user)
		if persona == "alice-null" {
			want.Email, want.EmailVerified, want.Name, want.AvatarURL = nil, nil, nil, nil
		}
		actual.ID = ""
		want.ID = ""
		_, err := uuid.Parse(draft.ID)
		identityHTTPCheck(p.t, err == nil && draft.UniAuthID != "" && reflect.DeepEqual(actual, want), "upstream profile write")
		p.mu.Lock()
		aliceClaim := p.aliceClaim
		if persona == "alice" {
			p.aliceClaim = draft.UniAuthID
		}
		p.mu.Unlock()
		switch persona {
		case "bob":
			identityHTTPCheck(p.t, draft.UniAuthID != aliceClaim, "distinct provider account identity")
		case "alice-updated", "alice-null":
			identityHTTPCheck(p.t, draft.UniAuthID == aliceClaim, "repeat provider account identity")
		}
		return user
	}}, {"InsertPersonalTeam", func(args []any) any {
		teamID = args[1].(string)
		_, err := uuid.Parse(teamID)
		identityHTTPCheck(p.t, err == nil && args[2].(string) == user.ID, "personal team write owner")
		identityHTTPNow(p.t, args[3].(time.Time))
		if persona == "alice" || persona == "bob" {
			user.PersonalTeam.ID = teamID
		}
		return persona == "alice" || persona == "bob"
	}}}
	if persona == "alice" || persona == "bob" {
		calls = append(calls, identityHTTPCall{"InsertPersonalOwner", func(args []any) any {
			identityHTTPCheck(p.t, args[1].(string) == teamID && args[2].(string) == user.ID, "personal owner write")
			identityHTTPNow(p.t, args[3].(time.Time))
			return nil
		}})
	} else {
		calls = append(calls, identityHTTPCall{"PersonalTeam", func(args []any) any {
			identityHTTPCheck(p.t, args[1].(string) == user.ID, "existing personal team owner")
			return store.PersonalTeamFacts{ID: user.PersonalTeam.ID, MemberCount: 1, OwnerAdminCount: 1}
		}})
	}
	calls = append(calls, identityHTTPCall{"IdentityUser", func(args []any) any {
		identityHTTPCheck(p.t, args[1].(string) == user.ID, "login identity read actor")
		return user
	}})
	calls = append(calls, identityHTTPCall{"InsertSession", func(args []any) any {
		session := args[1].(model.Session)
		_, err := uuid.Parse(session.ID)
		identityHTTPCheck(p.t, err == nil && session.UserID == user.ID && len(session.TokenHash) == 32 && session.ExpiresAt.Sub(session.CreatedAt) == identitycore.SessionLifetime, "session write arguments")
		identityHTTPNow(p.t, session.CreatedAt)
		p.mu.Lock()
		p.sessionDraft = identityHTTPCloneSession(session)
		p.mu.Unlock()
		return nil
	}})
	p.expect(calls...)
}

func identityHTTPPrincipal(user model.User, kind model.CredentialKind) model.Principal {
	return model.Principal{UserID: user.ID, CredentialID: "ccd40738-cf0e-49a7-8750-3f7476d0f710", Kind: kind}
}

func (p *identityHTTPPlan) authenticate(user model.User, kind model.CredentialKind, token string, success bool) {
	p.expect(identityHTTPCall{"Authenticate", func(args []any) any {
		identityHTTPCheck(p.t, args[1].(model.CredentialKind) == kind && bytes.Equal(args[2].([]byte), secret.Hash(token)), "authentication credential arguments")
		identityHTTPNow(p.t, args[3].(time.Time))
		if !success {
			return model.Unauthenticated(nil)
		}
		return identityHTTPPrincipal(user, kind)
	}})
}

func (p *identityHTTPPlan) user(user model.User) {
	p.expect(identityHTTPCall{"IdentityUser", func(args []any) any {
		identityHTTPCheck(p.t, args[1].(string) == user.ID, "identity read actor")
		return user
	}})
}

func identityHTTPBinding(state string) string {
	return "daynight_login_" + hex.EncodeToString(secret.Hash(state)[:16])
}

func identityCookie(t *testing.T, browser *http.Client, origin, name string) string {
	t.Helper()
	address, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	for _, cookie := range browser.Jar.Cookies(address) {
		if cookie.Name == name {
			return cookie.Value
		}
	}
	t.Fatalf("missing identity cookie %s", name)
	return ""
}
func (integration *identityIntegration) session(t *testing.T, browser *http.Client, user model.User) {
	integration.plan.authenticate(user, model.SessionCredential, identityCookie(t, browser, integration.server.URL, integration.sessionCookie), true)
}
func (integration *identityIntegration) me(t *testing.T, browser *http.Client, user model.User, headers map[string]string) {
	if header := headers["Authorization"]; header != "" {
		integration.plan.authenticate(user, model.PATCredential, strings.TrimPrefix(header, "Bearer "), true)
	} else {
		integration.session(t, browser, user)
	}
	integration.plan.user(user)
}
func (integration *identityIntegration) lockSession(principal model.Principal) identityHTTPCall {
	return identityHTTPCall{"LockSession", func(args []any) any {
		identityHTTPCheck(integration.plan.t, args[1].(model.Principal) == principal, "session lock actor")
		identityHTTPNow(integration.plan.t, args[2].(time.Time))
		return nil
	}}
}

func (p *identityHTTPPlan) assertPublications(users, sessions int32) {
	p.t.Helper()
	if p.upserts.Load() != users || p.sessions.Load() != sessions {
		p.t.Fatalf("identity publication calls: user=%d session=%d; want %d/%d", p.upserts.Load(), p.sessions.Load(), users, sessions)
	}
}

func (p *identityHTTPPlan) sessionWrite() model.Session {
	p.mu.Lock()
	defer p.mu.Unlock()
	return identityHTTPCloneSession(p.sessionDraft)
}

func identityHTTPClonePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}
func identityHTTPCloneUser(user model.User) model.User {
	user.Name = identityHTTPClonePointer(user.Name)
	user.Email = identityHTTPClonePointer(user.Email)
	user.EmailVerified = identityHTTPClonePointer(user.EmailVerified)
	user.AvatarURL = identityHTTPClonePointer(user.AvatarURL)
	user.PersonalTeam.Name = identityHTTPClonePointer(user.PersonalTeam.Name)
	return user
}
func identityHTTPCloneLogin(pending model.LoginTransaction) model.LoginTransaction {
	pending.StateHash = bytes.Clone(pending.StateHash)
	pending.BrowserBindingHash = bytes.Clone(pending.BrowserBindingHash)
	pending.ScopeHash = bytes.Clone(pending.ScopeHash)
	return pending
}
func identityHTTPCloneSession(session model.Session) model.Session {
	session.TokenHash = bytes.Clone(session.TokenHash)
	return session
}
func identityHTTPClonePAT(token model.PersonalAccessToken) model.PersonalAccessToken {
	token.TokenHash = bytes.Clone(token.TokenHash)
	token.ExpiresAt = identityHTTPClonePointer(token.ExpiresAt)
	return token
}

type identityIntegrationLogs struct {
	mu     sync.Mutex
	buffer bytes.Buffer
}

func (logs *identityIntegrationLogs) Write(value []byte) (int, error) {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return logs.buffer.Write(value)
}

func (logs *identityIntegrationLogs) count(value string) int {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return strings.Count(logs.buffer.String(), value)
}

func (logs *identityIntegrationLogs) contains(value string) bool {
	logs.mu.Lock()
	defer logs.mu.Unlock()
	return strings.Contains(logs.buffer.String(), value)
}

type identityIntegration struct {
	plan          *identityHTTPPlan
	server        *httptest.Server
	gateway       string
	client        *uniauth.Client
	logs          *identityIntegrationLogs
	sessionCookie string
	callbackPath  string
	secrets       []string
}

func newIdentityIntegration(t *testing.T) *identityIntegration {
	t.Helper()
	return newIdentityIntegrationCallback(t, "/api/v1/auth/callback")
}

func newIdentityIntegrationCallback(t *testing.T, callbackPath string) *identityIntegration {
	t.Helper()
	database, plan := newIdentityHTTPPlan(t)
	server := httptest.NewUnstartedServer(nil)
	t.Cleanup(server.Close)
	origin := "http://" + server.Listener.Addr().String()
	callback := origin + callbackPath
	logs := &identityIntegrationLogs{}
	ready := testauth.StartGatewayWithOutput(t, callback, logs)
	base := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(base.CloseIdleConnections)
	client, err := uniauth.New(uniauth.Config{BaseURL: ready.Origin, AppID: ready.AppID, AppSecret: ready.AppSecret, AllowLoopbackHTTP: true, HTTPClient: &http.Client{Timeout: 5 * time.Second, Transport: base}})
	if err != nil {
		t.Fatal("construct real UniAuth SDK client failed")
	}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	config := configuredTestConfig()
	config.Server.PublicOrigin, config.UniAuth.URL = origin, ready.Origin
	config.UniAuth.AppID, config.UniAuth.AppSecret, config.UniAuth.CallbackURL = ready.AppID, ready.AppSecret, callback
	config.Server.AllowHTTPTestOrigin, config.UniAuth.AllowLoopbackHTTP = true, true
	handler, err := newTestHandler(Dependencies{Store: database, Files: attachmentTestFiles(t)}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := handler.(Handler).Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	server.Config.Handler = httpx.RequestLogging(logger, handler)
	server.Start()
	return &identityIntegration{plan: plan, server: server, gateway: ready.Origin, client: client, logs: logs, sessionCookie: "daynight_session", callbackPath: callbackPath, secrets: []string{ready.AppSecret}}
}

func identityBrowser(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Jar: jar, Transport: transport, Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func identityRequest(t *testing.T, browser *http.Client, method, address, body string, headers map[string]string, status int) (*http.Response, []byte) {
	t.Helper()
	request, err := http.NewRequestWithContext(t.Context(), method, address, strings.NewReader(body))
	if err != nil {
		t.Fatal("construct integration HTTP request failed")
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := browser.Do(request)
	if err != nil {
		t.Fatal("integration HTTP request failed")
	}
	data, readError := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	closeError := response.Body.Close()
	if readError != nil || closeError != nil {
		t.Fatal("read integration HTTP response failed")
	}
	if response.StatusCode != status {
		t.Fatalf("%s %s returned HTTP %d; want %d", method, request.URL.Path, response.StatusCode, status)
	}
	return response, data
}

func identityDecode[T any](t *testing.T, data []byte) T {
	t.Helper()
	var result T
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatal("decode integration response failed")
	}
	return result
}

func (integration *identityIntegration) start(t *testing.T, browser *http.Client) *url.URL {
	t.Helper()
	write := integration.plan.start()
	loginURL := integration.server.URL + "/api/v1/auth/login?provider=github&returnPath=%2Fprojects%3Fview%3Dtasks"
	response, _ := identityRequest(t, browser, http.MethodGet, loginURL, "", nil, http.StatusSeeOther)
	if response.Header.Get("Location") == "/api/v1/auth/login?provider=github&returnPath=%2Fprojects%3Fview%3Dtasks" {
		response, _ = identityRequest(t, browser, http.MethodGet, loginURL, "", nil, http.StatusSeeOther)
	}
	authorization, err := response.Location()
	if err != nil || authorization.Scheme+"://"+authorization.Host != integration.gateway {
		t.Fatal("Daynight did not redirect to its real UniAuth gateway")
	}
	state := authorization.Query().Get("state")
	pending := write.value()
	identityHTTPCheck(t, bytes.Equal(pending.StateHash, secret.Hash(state)) && bytes.Equal(pending.ScopeHash, secret.Hash(identityCookie(t, browser, integration.server.URL, "daynight_login_scope"))) && bytes.Equal(pending.BrowserBindingHash, secret.Hash(identityCookie(t, browser, integration.server.URL, identityHTTPBinding(state)))), "login wire hashes differ from write arguments")
	integration.secrets = append(integration.secrets, state)
	response, _ = identityRequest(t, browser, http.MethodGet, authorization.String(), "", nil, http.StatusFound)
	upstream, err := response.Location()
	if err != nil || upstream.Scheme != "https" || upstream.Host != "github.com" || upstream.Path != "/login/oauth/authorize" || upstream.Query().Get("code_challenge_method") != "S256" || upstream.Query().Get("code_challenge") == "" {
		t.Fatal("real GitHub provider authorization or PKCE challenge changed")
	}
	if upstream.Query().Get("state") == authorization.Query().Get("state") {
		t.Fatal("UniAuth must own a separate browser-bound provider state")
	}
	integration.secrets = append(integration.secrets, upstream.Query().Get("state"))
	return upstream
}

func (integration *identityIntegration) providerCallback(t *testing.T, browser *http.Client, upstream *url.URL, persona string) *url.URL {
	t.Helper()
	values := url.Values{"state": {upstream.Query().Get("state")}}
	if persona == "denied" {
		values.Set("error", "access_denied")
	} else {
		values.Set("code", persona+":"+upstream.Query().Get("code_challenge"))
	}
	response, _ := identityRequest(t, browser, http.MethodGet, integration.gateway+"/auth/callback/github?"+values.Encode(), "", nil, http.StatusFound)
	callback, err := response.Location()
	if err != nil || callback.Scheme+"://"+callback.Host != integration.server.URL || callback.Path != integration.callbackPath {
		t.Fatal("UniAuth changed the registered Daynight callback")
	}
	if code := callback.Query().Get("code"); code != "" {
		integration.secrets = append(integration.secrets, code)
	}
	return callback
}

func (integration *identityIntegration) complete(t *testing.T, browser *http.Client, callback *url.URL) {
	t.Helper()
	integration.completeFor(t, browser, callback, "alice")
}

func (integration *identityIntegration) completeFor(t *testing.T, browser *http.Client, callback *url.URL, persona string) {
	t.Helper()
	integration.plan.consume(callback.Query().Get("state"), identityCookie(t, browser, integration.server.URL, identityHTTPBinding(callback.Query().Get("state"))), true)
	integration.plan.complete(persona)
	response, _ := identityRequest(t, browser, http.MethodGet, callback.String(), "", nil, http.StatusSeeOther)
	if response.Header.Get("Location") != "/auth/complete?"+(url.Values{"callbackPath": {integration.callbackPath}, "returnPath": {"/projects?view=tasks"}}).Encode() {
		t.Fatal("successful login did not retain its main-site return path")
	}
	for _, cookie := range response.Cookies() {
		if cookie.Name == integration.sessionCookie {
			draft := integration.plan.sessionWrite()
			identityHTTPCheck(t, bytes.Equal(draft.TokenHash, secret.Hash(cookie.Value)), "session response/write credential identity")
			if !cookie.HttpOnly || cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" || cookie.MaxAge <= 0 {
				t.Fatal("loopback session cookie attributes changed")
			}
			integration.secrets = append(integration.secrets, cookie.Value)
		}
	}
}

func (integration *identityIntegration) login(t *testing.T, browser *http.Client, persona string) api.User {
	t.Helper()
	integration.completeFor(t, browser, integration.providerCallback(t, browser, integration.start(t, browser), persona), persona)
	integration.me(t, browser, identityHTTPUser(persona), nil)
	_, data := identityRequest(t, browser, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusOK)
	return identityDecode[api.User](t, data)
}

func TestAuthenticationProvidersAndConfiguredCallbackUseProductionMux(t *testing.T) {
	integration := newIdentityIntegrationCallback(t, "/auth/callback")
	browser := identityBrowser(t)
	_, data := identityRequest(t, browser, http.MethodGet, integration.server.URL+"/api/v1/auth/providers", "", nil, http.StatusOK)
	providers := identityDecode[struct {
		Providers []string `json:"providers"`
	}](t, data)
	if !reflect.DeepEqual(providers.Providers, []string{"github"}) {
		t.Fatal("production provider discovery must return the actual App/provider intersection")
	}
	integration.login(t, browser, "alice")
	identityRequest(t, browser, http.MethodGet, integration.server.URL+"/api/v1/auth/callback", "", nil, http.StatusNotFound)
	identityRequest(t, browser, http.MethodGet, integration.server.URL+"/api/v1/auth/login?provider=github&returnPath=%2Fauth%2Fcallback", "", nil, http.StatusBadRequest)
	identityRequest(t, browser, http.MethodHead, integration.server.URL+"/auth/callback", "", nil, http.StatusMethodNotAllowed)
}

type resourceScopeAttachmentReader struct {
	store.AttachmentReader
	t    *testing.T
	plan *httpCallPlan
	item model.Attachment
}

func (r resourceScopeAttachmentReader) Attachment(_ context.Context, project, task, path string) (model.Attachment, error) {
	r.plan.Called("metadata")
	projectHTTPCheck(r.t, []string{project, task, path}, []string{r.item.ProjectID, r.item.TaskID, r.item.Path})
	return r.item, nil
}

func (r resourceScopeAttachmentReader) Attachments(_ context.Context, project, task string, query store.AttachmentQuery) (store.AttachmentPage, error) {
	r.plan.Called("attachments")
	projectHTTPCheck(r.t, []string{project, task}, []string{r.item.ProjectID, r.item.TaskID})
	projectHTTPCheck(r.t, query, store.AttachmentQuery{Limit: 50})
	return store.AttachmentPage{Items: []model.Attachment{r.item}}, nil
}

func resourceScopeServer(t *testing.T, tx store.Transactions, files filestorage.Storage, output io.Writer) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(nil)
	origin := "http://" + server.Listener.Addr().String()
	config := configuredTestConfig()
	config.Server.PublicOrigin, config.UniAuth.CallbackURL = origin, origin+"/api/v1/auth/callback"
	config.Server.AllowHTTPTestOrigin, config.UniAuth.AllowLoopbackHTTP = true, true
	logger := slog.New(slog.NewJSONHandler(output, nil))
	handler, err := newTestHandler(Dependencies{Store: tx, Files: files}, config, logger)
	if err != nil {
		t.Fatal(err)
	}
	server.Config.Handler = httpx.RequestLogging(logger, handler)
	server.Start()
	t.Cleanup(server.Close)
	t.Cleanup(func() {
		handler.(Handler).BeginShutdown()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := handler.(Handler).Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return server
}

func resourceScopeCookie(t *testing.T, browser *http.Client, origin, token string) {
	t.Helper()
	if !secret.Valid(token, "dnst_") {
		t.Fatal("scope fixture requires a canonical session credential")
	}
	address, err := url.Parse(origin)
	if err != nil {
		t.Fatal(err)
	}
	browser.Jar.SetCookies(address, []*http.Cookie{{Name: "daynight_session", Value: token, Path: "/"}})
}

func resourceScopeTaskCopy(task model.Task) model.Task {
	task.Properties = taskproperty.Clone(task.Properties)
	task.DependsOn = slices.Clone(task.DependsOn)
	task.ExternalDependsOn = slices.Clone(task.ExternalDependsOn)
	task.BlockedBy = slices.Clone(task.BlockedBy)
	task.AssignedTo = resourceScopePointer(task.AssignedTo)
	task.RequiredPlatform = resourceScopePointer(task.RequiredPlatform)
	task.StartedAt = resourceScopePointer(task.StartedAt)
	task.CompletedAt = resourceScopePointer(task.CompletedAt)
	task.CancelledAt = resourceScopePointer(task.CancelledAt)
	return task
}

func resourceScopePointer[T any](value *T) *T {
	if value == nil {
		return nil
	}
	copy := *value
	return &copy
}

func resourceScopeRead(t *testing.T, tx *httpTestStore, actor model.Principal, allowed bool, project model.Project, task model.Task, item model.Attachment, path string) *httpCallPlan {
	t.Helper()
	base := "/api/v1/projects/" + project.ID
	collection := base + "/tasks"
	taskPath := collection + "/" + task.ID
	want := map[string]int{"snapshot": 1, "access": 1}
	if allowed {
		switch path {
		case base:
			want["project"] = 1
		case base + "/task-graph?taskId=" + task.ID:
			want["project"], want["presence"], want["graph"], want["observed"] = 1, 1, 1, 1
		case collection:
			want["tasks"] = 1
		case taskPath:
			want["task"], want["epoch"] = 1, 1
		case taskPath + "/attachments":
			want["presence"], want["attachments"] = 1, 1
		case taskPath + "/attachments/files/" + item.Path, taskPath + "/preview/" + item.Path:
			want["presence"], want["metadata"] = 1, 1
		case base + "/members":
			want["participants"] = 1
		case base + "/invitations":
			want["invitations"] = 1
		default:
			t.Fatalf("unconfigured root resource: %s", path)
		}
	}
	plan := newHTTPCallPlan(t, want)
	projects := &taskHTTPProjectReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "resource.Project"), ProjectAccessFn: func(_ context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
		plan.Called("access")
		projectHTTPCheck(t, principal, actor)
		projectHTTPCheck(t, id, project.ID)
		if !allowed {
			return model.ProjectAccess{}, model.ErrNotFound
		}
		return taskHTTPMockAccess(project, actor), nil
	}, ProjectFn: func(_ context.Context, id string) (model.Project, error) {
		plan.Called("project")
		projectHTTPCheck(t, id, project.ID)
		return project, nil
	}, ProjectParticipantsFn: func(_ context.Context, id string) ([]model.ProjectParticipant, error) {
		plan.Called("participants")
		projectHTTPCheck(t, id, project.ID)
		return []model.ProjectParticipant{}, nil
	}, InvitationsFn: func(_ context.Context, id string, now time.Time) ([]model.ProjectInvitation, error) {
		plan.Called("invitations")
		projectHTTPCheck(t, id, project.ID)
		identityHTTPNow(t, now)
		return []model.ProjectInvitation{}, nil
	}}
	selection := store.TaskGraphSelection{OrdinaryPrerequisites: true, OrdinaryDependents: true, DirectExternal: true, LiveOnly: true}
	tasks := &taskHTTPReaderMock{taskHTTPMockBase: newTaskHTTPMockBase(t, "resource.Task"), TaskFn: func(_ context.Context, projectID, id string) (model.Task, error) {
		plan.Called("task")
		projectHTTPCheck(t, []string{projectID, id}, []string{project.ID, task.ID})
		return resourceScopeTaskCopy(task), nil
	}, TasksFn: func(_ context.Context, id string, query store.TaskQuery) (store.TaskPage, error) {
		plan.Called("tasks")
		projectHTTPCheck(t, id, project.ID)
		projectHTTPCheck(t, query, store.TaskQuery{TagFilter: store.TagFilter{TagIDs: []string{}, TagMatch: "all"}, Page: store.Page{Limit: 50}})
		return store.TaskPage{Items: []model.Task{resourceScopeTaskCopy(task)}}, nil
	}, TaskPresenceFn: func(_ context.Context, projectID, id string) (store.TaskPresence, error) {
		plan.Called("presence")
		projectHTTPCheck(t, []string{projectID, id}, []string{project.ID, task.ID})
		return store.TaskPresence{Found: true}, nil
	}, TaskCacheEpochFn: func(_ context.Context, id string) (string, error) {
		plan.Called("epoch")
		projectHTTPCheck(t, id, project.ID)
		return "resource-scope", nil
	},
		TaskGraphTasksFn: func(_ context.Context, projectID, id string, got store.TaskGraphSelection, characters int) ([]model.GraphTask, error) {
			plan.Called("graph")
			projectHTTPCheck(t, []string{projectID, id}, []string{project.ID, task.ID})
			projectHTTPCheck(t, got, selection)
			projectHTTPCheck(t, characters, projection.TitlePreviewCharacters)
			return []model.GraphTask{{ID: task.ID, TitlePreview: task.Title, Status: task.Status, DependsOn: []string{}, ExternalDependsOn: []string{}, BlockedBy: []string{}, Ready: true, CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}}, nil
		}}
	snapshot := newHTTPTestSnapshot(t)
	snapshot.Projects, snapshot.Tasks, snapshot.Attachments = projects, tasks, resourceScopeAttachmentReader{t: t, plan: plan, item: item}
	snapshot.ObservedAtCall = func(context.Context) (time.Time, error) { plan.Called("observed"); return task.UpdatedAt, nil }
	tx.ReadSnapshotCall = func(ctx context.Context, fn func(store.SnapshotScope) error) error {
		plan.Called("snapshot")
		return fn(snapshot)
	}
	return plan
}

func resourceScopeAuthentication(t *testing.T, tx *httpTestStore, actor model.Principal, token string) {
	t.Helper()
	plan := newHTTPCallPlan(t, map[string]int{"authentication": 1})
	tx.WriteIdentityCall = func(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
		plan.Called("authentication")
		dao := &httpAuthenticationDAO{httpRejectedIdentityDAO: httpRejectedIdentityDAO{t: t}, principal: actor, hash: secret.Hash(token)}
		err := fn(httpAuthenticationScope{t: t, dao: dao})
		if dao.calls != 1 {
			unexpectedHTTPCall(t, "root authentication callback")
		}
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}
}

func TestPrivateProjectResourceHTTPAuthenticationAndScope(t *testing.T) {
	project, task, _ := taskHTTPMockModels()
	project.Name, project.RepoURL = "Private resource scope", "https://example.test/private"
	task.Title, task.AssignedTo = "Private resource", nil
	ownerActor, outsiderActor := identityHTTPPrincipal(identityHTTPUser("alice"), model.SessionCredential), identityHTTPPrincipal(identityHTTPUser("bob"), model.SessionCredential)
	files := attachmentTestFiles(t)
	address, err := attachmentcore.NewAddress(project.ID, task.ID, "private.html")
	if err != nil {
		t.Fatal(err)
	}
	const content = "<p>private content</p>"
	if info, err := files.Put(t.Context(), attachmentcore.Bucket, address.StoragePath, strings.NewReader(content)); err != nil || info.Size != int64(len(content)) {
		t.Fatalf("scope content fixture: %+v %v", info, err)
	}
	item := model.Attachment{ProjectID: project.ID, TaskID: task.ID, Path: "private.html", ContentType: "text/html", SizeBytes: int64(len(content)), CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}
	tx := newHTTPTestStore(t)
	server := resourceScopeServer(t, tx, files, io.Discard)
	owner, outsider, anonymous := identityBrowser(t), identityBrowser(t), identityBrowser(t)
	ownerToken, outsiderToken := httpTestToken(model.SessionCredential), "dnst_"+strings.Repeat("B", 42)+"A"
	resourceScopeCookie(t, owner, server.URL, ownerToken)
	resourceScopeCookie(t, outsider, server.URL, outsiderToken)
	base := "/api/v1/projects/" + project.ID
	file, preview := base+"/tasks/"+task.ID+"/attachments/files/private.html", base+"/tasks/"+task.ID+"/preview/private.html"
	paths := []string{base, base + "/task-graph?taskId=" + task.ID, base + "/tasks", base + "/tasks/" + task.ID, base + "/tasks/" + task.ID + "/attachments", file, preview, base + "/members", base + "/invitations"}
	for _, path := range paths {
		resourceScopeAuthentication(t, tx, ownerActor, ownerToken)
		plan := resourceScopeRead(t, tx, ownerActor, true, project, task, item, path)
		_, body := identityRequest(t, owner, http.MethodGet, server.URL+path, "", nil, http.StatusOK)
		if (path == file || path == preview) && string(body) != content {
			t.Fatalf("private bytes: %s", body)
		}
		plan.Verify()
		for _, test := range []struct {
			name   string
			client *http.Client
			actor  model.Principal
			token  string
			status int
			code   string
		}{{"nonmember", outsider, outsiderActor, outsiderToken, http.StatusNotFound, "not_found"}, {"anonymous", anonymous, model.Principal{}, "", http.StatusUnauthorized, "unauthenticated"}} {
			t.Run(test.name+"/"+path, func(t *testing.T) {
				if test.token != "" {
					resourceScopeAuthentication(t, tx, test.actor, test.token)
					resourceScopeRead(t, tx, test.actor, false, project, task, item, path)
				}
				response, body := identityRequest(t, test.client, http.MethodGet, server.URL+path, "", nil, test.status)
				mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
				if err != nil || mediaType != "application/json" {
					t.Fatalf("denial content type: %q, %v", response.Header.Get("Content-Type"), err)
				}
				var envelope api.ErrorResponse
				if err := json.Unmarshal(body, &envelope); err != nil || envelope.Error.Code != test.code {
					t.Fatalf("denial envelope: %s, %v", body, err)
				}
			})
		}
	}
	resourceScopeAuthentication(t, tx, ownerActor, ownerToken)
	resourceScopeRead(t, tx, ownerActor, true, project, task, item, preview)
	_, ownerHead := identityRequest(t, owner, http.MethodHead, server.URL+preview, "", nil, http.StatusOK)
	if len(ownerHead) != 0 {
		t.Fatal("authorized preview HEAD returned a body")
	}
	for _, test := range []struct {
		name   string
		client *http.Client
		status int
	}{{"nonmember", outsider, http.StatusNotFound}, {"anonymous", anonymous, http.StatusUnauthorized}} {
		t.Run(test.name+"/preview-head", func(t *testing.T) {
			if test.name == "nonmember" {
				resourceScopeAuthentication(t, tx, outsiderActor, outsiderToken)
				resourceScopeRead(t, tx, outsiderActor, false, project, task, item, preview)
			}
			response, body := identityRequest(t, test.client, http.MethodHead, server.URL+preview, "", nil, test.status)
			mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
			if err != nil || mediaType != "application/json" || len(body) != 0 {
				t.Fatalf("HEAD denial: type=%q bytes=%d error=%v", response.Header.Get("Content-Type"), len(body), err)
			}
		})
	}
}

func TestPrivateProjectListsRemainIsolatedAcrossPATs(t *testing.T) {
	tx, plan := newIdentityHTTPPlan(t)
	logs := &identityIntegrationLogs{}
	server := resourceScopeServer(t, tx, attachmentTestFiles(t), logs)
	alice, bob := identityBrowser(t), identityBrowser(t)
	aliceUser, bobUser := identityHTTPUser("alice"), identityHTTPUser("bob")
	if aliceUser.ID == bobUser.ID {
		t.Fatal("fixture identities are not distinct")
	}
	resourceScopeCookie(t, alice, server.URL, httpTestToken(model.SessionCredential))
	resourceScopeCookie(t, bob, server.URL, "dnst_"+strings.Repeat("B", 42)+"A")
	integration := &identityIntegration{plan: plan, server: server, logs: logs, sessionCookie: "daynight_session"}
	origin := map[string]string{"Origin": server.URL}
	bobActor := identityHTTPPrincipal(bobUser, model.SessionCredential)
	integration.session(t, bob, bobUser)
	projectHTTPCreate(t, tx, bobActor, "Bob private project", "https://example.test/bob", bobUser.PersonalTeam.ID, false)
	_, data := identityRequest(t, bob, http.MethodPost, server.URL+"/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Bob private project", RepoURL: "https://example.test/bob", ExpectedUserID: bobUser.ID}), origin, http.StatusCreated)
	bobProject := identityDecode[api.Project](t, data)
	mint := func(browser *http.Client, user model.User, name string) api.CreatedPersonalAccessToken {
		t.Helper()
		integration.session(t, browser, user)
		var draft model.PersonalAccessToken
		plan.expect(integration.lockSession(identityHTTPPrincipal(user, model.SessionCredential)), identityHTTPCall{"CleanupCredentials", func(args []any) any { identityHTTPNow(t, args[1].(time.Time)); return nil }}, identityHTTPCall{"InsertPAT", func(args []any) any {
			draft = args[1].(model.PersonalAccessToken)
			if draft.UserID != user.ID || draft.Name != name || draft.ExpiresAt != nil {
				unexpectedHTTPCall(t, "private PAT draft")
			}
			return nil
		}})
		_, body := identityRequest(t, browser, http.MethodPost, server.URL+"/api/v1/me/tokens", jsonBody(t, map[string]any{"name": name, "expiresAt": nil}), origin, http.StatusCreated)
		created := identityDecode[api.CreatedPersonalAccessToken](t, body)
		if created.ID == "" || !strings.HasPrefix(created.Token, "dnpat_") || created.ID != draft.ID || !bytes.Equal(draft.TokenHash, secret.Hash(created.Token)) {
			t.Fatal("PAT creation did not return its proposed credential")
		}
		return created
	}
	aliceToken, bobToken := mint(alice, aliceUser, "Alice project access"), mint(bob, bobUser, "Bob project access")
	alicePAT, bobPAT := identityBrowser(t), identityBrowser(t)
	aliceBearer, bobBearer := map[string]string{"Authorization": "Bearer " + aliceToken.Token}, map[string]string{"Authorization": "Bearer " + bobToken.Token}
	list := func(client *http.Client, bearer map[string]string, user model.User, project api.Project) api.ProjectPage {
		t.Helper()
		plan.authenticate(user, model.PATCredential, strings.TrimPrefix(bearer["Authorization"], "Bearer "), true)
		stored := projectHTTPRecord(project.ID, project.Name, project.RepoURL, project.Ownership.TeamID)
		projectHTTPPage(t, tx, identityHTTPPrincipal(user, model.PATCredential), projectHTTPListScope(store.ProjectScopeAll, ""), store.Page{Limit: 50}, []model.Project{stored}, false)
		response, body := identityRequest(t, client, http.MethodGet, server.URL+"/api/v1/projects", "", bearer, http.StatusOK)
		if response.Header.Get("Daynight-User-ID") != user.ID {
			t.Fatal("PAT project response lost its authenticated identity")
		}
		return identityDecode[api.ProjectPage](t, body)
	}
	bobBefore := list(bobPAT, bobBearer, bobUser, bobProject)
	if len(bobBefore.Items) != 1 || bobBefore.Items[0] != bobProject || bobBefore.NextCursor != nil {
		t.Fatalf("Bob's initial project scope: %+v", bobBefore)
	}
	plan.authenticate(aliceUser, model.PATCredential, aliceToken.Token, true)
	projectHTTPCreate(t, tx, identityHTTPPrincipal(aliceUser, model.PATCredential), "Alice private project", "https://example.test/alice", aliceUser.PersonalTeam.ID, false)
	_, data = identityRequest(t, alicePAT, http.MethodPost, server.URL+"/api/v1/projects", jsonBody(t, api.CreateProjectRequest{Name: "Alice private project", RepoURL: "https://example.test/alice", ExpectedUserID: aliceUser.ID}), aliceBearer, http.StatusCreated)
	aliceProject := identityDecode[api.Project](t, data)
	alicePage := list(alicePAT, aliceBearer, aliceUser, aliceProject)
	if len(alicePage.Items) != 1 || alicePage.Items[0] != aliceProject || alicePage.Items[0].ID == bobProject.ID || alicePage.NextCursor != nil {
		t.Fatalf("Alice's PAT project scope: %+v", alicePage)
	}
	bobAfter := list(bobPAT, bobBearer, bobUser, bobProject)
	if !reflect.DeepEqual(bobAfter, bobBefore) {
		t.Fatalf("Alice's project creation changed Bob's scope: %+v", bobAfter)
	}
	integration.session(t, alice, aliceUser)
	plan.expect(integration.lockSession(identityHTTPPrincipal(aliceUser, model.SessionCredential)), identityHTTPCall{"DeletePAT", func(args []any) any {
		projectHTTPCheck(t, []string{args[1].(string), args[2].(string)}, []string{aliceUser.ID, aliceToken.ID})
		return nil
	}})
	identityRequest(t, alice, http.MethodDelete, server.URL+"/api/v1/me/tokens/"+aliceToken.ID, "", origin, http.StatusNoContent)
	plan.authenticate(aliceUser, model.PATCredential, aliceToken.Token, false)
	identityRequest(t, alicePAT, http.MethodGet, server.URL+"/api/v1/projects", "", aliceBearer, http.StatusUnauthorized)
	if afterRevocation := list(bobPAT, bobBearer, bobUser, bobProject); !reflect.DeepEqual(afterRevocation, bobBefore) {
		t.Fatal("Alice's PAT revocation changed Bob's access")
	}
	if logs.contains(aliceToken.Token) || logs.contains(bobToken.Token) {
		t.Fatal("project request diagnostics exposed a PAT")
	}
}
