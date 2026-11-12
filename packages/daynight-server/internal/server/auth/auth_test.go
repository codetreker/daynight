package auth

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
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
	identitycore "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	profileprotocol "github.com/codetreker/daynight/packages/daynight-server/internal/protocol/profile"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
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

func (s *identityHTTPScope) CredentialFamilyDAO() store.CredentialFamilyDAO {
	unexpectedHTTPCall(s.t, "CredentialFamilyDAO")
	return nil
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

func newIdentityHTTPPlan(t *testing.T) *identityHTTPPlan {
	t.Helper()
	p := &identityHTTPPlan{t: t}
	t.Cleanup(func() {
		p.mu.Lock()
		defer p.mu.Unlock()
		if len(p.scopes) != 0 {
			t.Errorf("%d identity scopes were not called", len(p.scopes))
		}
	})
	return p
}

func (p *identityHTTPPlan) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	t := p.t
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

func unexpectedHTTPCall(t *testing.T, name string) {
	t.Helper()
	t.Errorf("unconfigured or extra DAO call: %s", name)
	panic("unconfigured or extra DAO call: " + name)
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
	plan := newIdentityHTTPPlan(t)
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
	server.Config.Handler = identityHTTPHandler(t, plan, origin, callback, client, logger)
	server.Start()
	return &identityIntegration{plan: plan, server: server, gateway: ready.Origin, client: client, logs: logs, sessionCookie: "daynight_session", callbackPath: callbackPath, secrets: []string{ready.AppSecret}}
}

func identityHTTPHandler(t *testing.T, plan *identityHTTPPlan, origin, callback string, client *uniauth.Client, logger *slog.Logger) http.Handler {
	t.Helper()
	identity := identityservice.New(plan, client, callback)
	handler, err := NewAuthentication(identity, authconfig.AuthSettings{PublicOrigin: origin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	handler.RegisterRoutes(mux)
	return httpx.RequestLogging(logger, mux)
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

func TestAuthenticationUniAuthIdentityAndCredentials(t *testing.T) {
	integration := newIdentityIntegration(t)
	aliceBrowser, bobBrowser := identityBrowser(t), identityBrowser(t)
	alice := integration.login(t, aliceBrowser, "alice")
	bob := integration.login(t, bobBrowser, "bob")
	if alice.ID == "" || bob.ID == "" || alice.ID == bob.ID || alice.Email == nil || bob.Email == nil || *alice.Email != *bob.Email {
		t.Fatal("provider IDs must produce distinct local users even with the same email")
	}
	if alice.Name == nil || *alice.Name != "Alice" || alice.EmailVerified == nil || !*alice.EmailVerified || alice.AvatarURL == nil {
		t.Fatal("real GitHub profile was not projected to the local user")
	}
	updated := integration.login(t, aliceBrowser, "alice-updated")
	if updated.ID != alice.ID || updated.Name == nil || *updated.Name != "Alice Updated" || updated.Email == nil || *updated.Email != "refreshed@example.test" || updated.EmailVerified == nil || *updated.EmailVerified || updated.AvatarURL == nil || *updated.AvatarURL == *alice.AvatarURL {
		t.Fatal("repeat login did not refresh the existing user's full profile")
	}
	cleared := integration.login(t, aliceBrowser, "alice-null")
	if cleared.ID != alice.ID || cleared.Email != nil || cleared.EmailVerified != nil || cleared.Name != nil || cleared.AvatarURL != nil {
		t.Fatal("nullable upstream profile must clear old values without changing local identity")
	}
	integration.me(t, bobBrowser, identityHTTPUser("bob"), nil)
	_, data := identityRequest(t, bobBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusOK)
	if !reflect.DeepEqual(identityDecode[api.User](t, data), bob) {
		t.Fatal("refreshing Alice changed Bob's same-email account")
	}
	origin := map[string]string{"Origin": integration.server.URL}
	aliceUser := identityHTTPUser("alice-null")
	sessionActor := identityHTTPPrincipal(aliceUser, model.SessionCredential)
	integration.session(t, aliceBrowser, aliceUser)
	identityRequest(t, aliceBrowser, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"CLI acceptance","expiresAt":null}`, nil, http.StatusForbidden)
	integration.session(t, aliceBrowser, aliceUser)
	var draftedToken model.PersonalAccessToken
	var draftMu sync.Mutex
	integration.plan.expect(integration.lockSession(sessionActor), identityHTTPCall{"CleanupCredentials", func(args []any) any { identityHTTPNow(t, args[1].(time.Time)); return nil }}, identityHTTPCall{"InsertPAT", func(args []any) any {
		draft := args[1].(model.PersonalAccessToken)
		identityHTTPCheck(t, draft.UserID == aliceUser.ID && draft.Name == "CLI acceptance" && draft.ExpiresAt == nil && len(draft.TokenHash) == 32, "PAT write arguments")
		identityHTTPNow(t, draft.CreatedAt)
		draftMu.Lock()
		draftedToken = identityHTTPClonePAT(draft)
		draftMu.Unlock()
		return nil
	}})
	_, data = identityRequest(t, aliceBrowser, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"CLI acceptance","expiresAt":null}`, origin, http.StatusCreated)
	token := identityDecode[api.CreatedPersonalAccessToken](t, data)
	if token.ID == "" || !strings.HasPrefix(token.Token, "dnpat_") || token.Name != "CLI acceptance" || token.ExpiresAt != nil {
		t.Fatal("personal token creation contract changed")
	}
	draftMu.Lock()
	draft := identityHTTPClonePAT(draftedToken)
	draftMu.Unlock()
	identityHTTPCheck(t, draft.ID == token.ID && bytes.Equal(draft.TokenHash, secret.Hash(token.Token)), "PAT response/write identity")
	integration.secrets = append(integration.secrets, token.Token)
	bearer := map[string]string{"Authorization": "Bearer " + token.Token}
	patBrowser := identityBrowser(t)
	integration.me(t, patBrowser, aliceUser, bearer)
	_, data = identityRequest(t, patBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", bearer, http.StatusOK)
	if !reflect.DeepEqual(identityDecode[api.User](t, data), cleared) {
		t.Fatal("PAT did not authenticate its owning user")
	}
	integration.plan.authenticate(aliceUser, model.PATCredential, token.Token, true)
	identityRequest(t, patBrowser, http.MethodGet, integration.server.URL+"/api/v1/me/tokens", "", bearer, http.StatusForbidden)
	integration.plan.authenticate(aliceUser, model.PATCredential, token.Token, true)
	identityRequest(t, patBrowser, http.MethodPost, integration.server.URL+"/api/v1/me/tokens", `{"name":"forbidden","expiresAt":null}`, bearer, http.StatusForbidden)
	identityRequest(t, aliceBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", map[string]string{"Authorization": "Bearer invalid"}, http.StatusUnauthorized)
	integration.session(t, aliceBrowser, aliceUser)
	listedToken := model.PersonalAccessToken{ID: token.ID, UserID: aliceUser.ID, Name: "CLI acceptance", CreatedAt: token.CreatedAt}
	integration.plan.expect(integration.lockSession(sessionActor), identityHTTPCall{"ListPATs", func(args []any) any {
		identityHTTPCheck(t, args[1].(string) == aliceUser.ID, "PAT list owner")
		identityHTTPNow(t, args[2].(time.Time))
		return []model.PersonalAccessToken{listedToken}
	}})
	_, data = identityRequest(t, aliceBrowser, http.MethodGet, integration.server.URL+"/api/v1/me/tokens", "", nil, http.StatusOK)
	listed := identityDecode[api.PersonalAccessTokenList](t, data)
	if len(listed.Items) != 1 || listed.Items[0].ID != token.ID || bytes.Contains(data, []byte(token.Token)) {
		t.Fatal("token list must expose only its owner's token metadata")
	}
	integration.session(t, aliceBrowser, aliceUser)
	integration.plan.expect(integration.lockSession(sessionActor), identityHTTPCall{"DeletePAT", func(args []any) any {
		identityHTTPCheck(t, args[1].(string) == aliceUser.ID && args[2].(string) == token.ID, "PAT delete actor and ID")
		return nil
	}})
	identityRequest(t, aliceBrowser, http.MethodDelete, integration.server.URL+"/api/v1/me/tokens/"+token.ID, "", origin, http.StatusNoContent)
	integration.plan.authenticate(aliceUser, model.PATCredential, token.Token, false)
	identityRequest(t, patBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", bearer, http.StatusUnauthorized)
	integration.session(t, aliceBrowser, aliceUser)
	integration.plan.expect(identityHTTPCall{"DeleteSession", func(args []any) any {
		identityHTTPCheck(t, args[1].(model.Principal) == sessionActor, "session logout actor")
		return nil
	}})
	identityRequest(t, aliceBrowser, http.MethodPost, integration.server.URL+"/api/v1/auth/logout", "", origin, http.StatusNoContent)
	identityRequest(t, aliceBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusUnauthorized)
	for _, secret := range integration.secrets {
		if secret != "" && integration.logs.contains(secret) {
			t.Fatal("authentication logs exposed a credential or OAuth handover value")
		}
	}
}

func TestAuthenticationUniAuthBrowserBindingAndConsumption(t *testing.T) {
	integration := newIdentityIntegration(t)
	browser, stranger := identityBrowser(t), identityBrowser(t)
	callback := integration.providerCallback(t, browser, integration.start(t, browser), "alice")
	before := integration.logs.count("type=fixture_result_request")
	identityRequest(t, stranger, http.MethodGet, callback.String(), "", nil, http.StatusUnauthorized)
	identityRequest(t, stranger, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusUnauthorized)
	if integration.logs.count("type=fixture_result_request") != before {
		t.Fatal("an unbound callback retrieved the gateway result")
	}
	integration.complete(t, browser, callback)
	if integration.logs.count("type=fixture_result_request") != before+1 {
		t.Fatal("a bound login must retrieve its one-time gateway result exactly once")
	}
	identityRequest(t, browser, http.MethodGet, callback.String(), "", nil, http.StatusUnauthorized)
	if integration.logs.count("type=fixture_result_request") != before+1 {
		t.Fatal("a repeated Daynight callback retrieved the result again")
	}
	_, err := integration.client.Retrieve(t.Context(), callback.Query().Get("code"))
	var unavailable *uniauth.APIError
	if !errors.As(err, &unavailable) || unavailable.StatusCode != http.StatusGone || unavailable.Code != "result_unavailable" {
		t.Fatal("real UniAuth result remained available after Daynight consumed it")
	}
	deniedBrowser := identityBrowser(t)
	denied := integration.providerCallback(t, deniedBrowser, integration.start(t, deniedBrowser), "denied")
	if denied.Query().Get("error") == "" || denied.Query().Get("code") != "" {
		t.Fatal("real provider denial did not become a gateway error callback")
	}
	mainURL, err := url.Parse(integration.server.URL)
	if err != nil {
		t.Fatal(err)
	}
	bindings := deniedBrowser.Jar.Cookies(mainURL)
	before = integration.logs.count("type=fixture_result_request")
	deniedBinding := identityCookie(t, deniedBrowser, integration.server.URL, identityHTTPBinding(denied.Query().Get("state")))
	integration.plan.consume(denied.Query().Get("state"), deniedBinding, true)
	response, _ := identityRequest(t, deniedBrowser, http.MethodGet, denied.String(), "", nil, http.StatusSeeOther)
	if response.Header.Get("Location") != "/login?authError=login_failed&returnPath=%2Fprojects%3Fview%3Dtasks" {
		t.Fatal("provider denial did not produce the generic login failure")
	}
	identityRequest(t, deniedBrowser, http.MethodGet, integration.server.URL+"/api/v1/me", "", nil, http.StatusUnauthorized)
	deniedBrowser.Jar.SetCookies(mainURL, bindings)
	integration.plan.consume(denied.Query().Get("state"), deniedBinding, false)
	identityRequest(t, deniedBrowser, http.MethodGet, denied.String(), "", nil, http.StatusUnauthorized)
	if integration.logs.count("type=fixture_result_request") != before {
		t.Fatal("provider denial or its replay retrieved an identity result")
	}
	for _, secret := range integration.secrets {
		if secret != "" && integration.logs.contains(secret) {
			t.Fatal("authentication logs exposed a credential or OAuth handover value")
		}
	}
}

func (d httpRejectedIdentityDAO) LockProfileCredential(context.Context, model.Principal, time.Time) error {
	unexpectedHTTPCall(d.t, "IdentityDAO.LockProfileCredential")
	panic("unreachable")
}
func (d httpRejectedIdentityDAO) EnsureUser(context.Context, model.User, time.Time) (model.User, bool, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.EnsureUser")
	return model.User{}, false, nil
}
func (d httpRejectedIdentityDAO) PatchUser(context.Context, string, model.UserProfilePatch) (model.User, error) {
	unexpectedHTTPCall(d.t, "IdentityDAO.PatchUser")
	return model.User{}, nil
}
