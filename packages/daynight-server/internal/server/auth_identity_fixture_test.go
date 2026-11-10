package server

import (
	"bytes"
	"context"
	"encoding/hex"
	"net/http"
	"net/url"
	"reflect"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	profileprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/profile"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
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
	case "alice-updated":
		user.Name = text("Alice Updated")
		user.Email = text("refreshed@example.test")
		user.EmailVerified = boolean(false)
		user.AvatarURL = text("https://images.example.test/alice-updated.png")
	case "alice-null":
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
