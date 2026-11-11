package identity

import (
	"context"
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

// identityDAO supplies persistence facts and injectable failures; domain rules
// are exercised through the module rather than reproduced by the fixture.
type identityDAO struct {
	store.IdentityDAO
	failures      map[string]error
	calls         []string
	pending       model.LoginTransaction
	user          model.User
	principal     model.Principal
	facts         store.PersonalTeamFacts
	pat           model.PersonalAccessToken
	pats          []model.PersonalAccessToken
	device        model.DeviceAuthorization
	attempts      int
	admissionTime time.Time
	rejection     string
}

func (d *identityDAO) hit(name string) error {
	d.calls = append(d.calls, name)
	return d.failures[name]
}
func (d *identityDAO) CleanupCredentials(context.Context, time.Time) error { return d.hit("cleanup") }
func (d *identityDAO) CleanupLoginCredentials(context.Context, time.Time, time.Time) error {
	return d.hit("cleanup")
}
func (d *identityDAO) AdmitLogin(_ context.Context, _ []byte, _, _ int) (time.Time, string, error) {
	return d.admissionTime, d.rejection, d.hit("admit")
}
func (d *identityDAO) InsertLogin(_ context.Context, p model.LoginTransaction) error {
	d.pending = p
	return d.hit("insert-login")
}
func (d *identityDAO) ConsumeLogin(context.Context, []byte, []byte, time.Time) (model.LoginTransaction, error) {
	return d.pending, d.hit("consume-login")
}
func (d *identityDAO) UpsertUser(_ context.Context, u model.User, _ time.Time) (model.User, error) {
	d.user = u
	return u, d.hit("upsert")
}
func (d *identityDAO) InsertSession(context.Context, model.Session) error { return d.hit("session") }
func (d *identityDAO) Authenticate(context.Context, model.CredentialKind, []byte, time.Time) (model.Principal, error) {
	return d.principal, d.hit("authenticate")
}
func (d *identityDAO) IdentityUser(context.Context, string) (model.User, store.PersonalTeamFacts, error) {
	return d.user, d.facts, d.hit("user")
}
func (d *identityDAO) DeleteSession(context.Context, model.Principal) error {
	return d.hit("delete-session")
}
func (d *identityDAO) LockSession(context.Context, model.Principal, time.Time) error {
	return d.hit("lock-session")
}
func (d *identityDAO) InsertPAT(_ context.Context, p model.PersonalAccessToken) error {
	d.pat = p
	return d.hit("insert-pat")
}
func (d *identityDAO) ListPATs(context.Context, string, time.Time) ([]model.PersonalAccessToken, error) {
	return d.pats, d.hit("list-pat")
}
func (d *identityDAO) DeletePAT(context.Context, string, string) error { return d.hit("delete-pat") }
func (d *identityDAO) LockActivePAT(context.Context, string, string, time.Time) (model.PersonalAccessToken, error) {
	return d.pat, d.hit("lock-pat")
}
func (d *identityDAO) SetPATExpiry(_ context.Context, _ string, e *time.Time) (model.PersonalAccessToken, error) {
	d.pat.ExpiresAt = e
	return d.pat, d.hit("set-expiry")
}
func (d *identityDAO) PruneDeviceRates(context.Context, time.Time) error { return d.hit("prune-rate") }
func (d *identityDAO) IncrementDeviceRate(context.Context, model.DeviceRateBucket, time.Time) (int, error) {
	return d.attempts, d.hit("increment-rate")
}
func (d *identityDAO) PruneDevices(context.Context, time.Time) error { return d.hit("prune-device") }
func (d *identityDAO) InsertDevice(_ context.Context, p model.DeviceAuthorization) error {
	d.device = p
	return d.hit("insert-device")
}
func (d *identityDAO) DeviceByUserCode(context.Context, string, string, bool) (model.DeviceAuthorization, error) {
	return d.device, d.hit("user-code")
}
func (d *identityDAO) LockDeviceByHash(context.Context, []byte) (model.DeviceAuthorization, error) {
	return d.device, d.hit("device-hash")
}
func (d *identityDAO) SetDeviceDecision(context.Context, string, string, string) error {
	return d.hit("decision")
}
func (d *identityDAO) DelayDevicePoll(context.Context, string, time.Time, bool) error {
	return d.hit("poll")
}
func (d *identityDAO) ConsumeDevice(context.Context, string) error { return d.hit("consume-device") }

func checkFault(t *testing.T, err error, code string) {
	t.Helper()
	var f *model.Fault
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("expected %s fault, got %v", code, err)
	}
}
func checkGrant(t *testing.T, err error, code string) {
	t.Helper()
	var f *DeviceGrantError
	if !errors.As(err, &f) || f.Code != code || f.Error() == "" {
		t.Fatalf("expected %s grant, got %v", code, err)
	}
}

func TestLoginRulesAndPersistenceFailures(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	m := NewIdentity("https://example.test/auth/callback")
	d := &identityDAO{admissionTime: now}
	failure := errors.New("database failure")
	if m.CallbackURL() != "https://example.test/auth/callback" {
		t.Fatal("callback changed")
	}
	for _, in := range []struct{ provider, path string }{{"other", "/"}, {"github", "https://evil.test"}, {"github", "//evil.test"}, {"github", "/login"}, {"github", "/auth/callback"}, {"github", "/api/v1/auth/login"}, {"github", "/bad%zz"}, {"github", "/bad\\path"}, {"github", string([]byte{0xff})}} {
		_, _, err := m.StartLogin(in.provider, in.path, now)
		checkFault(t, err, "invalid_input")
	}
	if _, _, err := NewIdentity("https://%zz").StartLogin("github", "/", now); err == nil {
		t.Fatal("invalid callback accepted")
	}
	start, pending, err := m.StartLogin("github", "", now)
	if err != nil || pending.ReturnPath != "/projects" || pending.ID != start.ID || !secret.Valid(start.State, "") || !start.ExpiresAt.Equal(now.Add(LoginLifetime)) {
		t.Fatalf("login preparation: %#v %#v %v", start, pending, err)
	}
	d.failures = map[string]error{"cleanup": failure}
	if _, err = m.CreateLogin(ctx, d, pending, now); !errors.Is(err, failure) {
		t.Fatalf("cleanup failure: %v", err)
	}
	d.failures = nil
	if _, err = m.CreateLogin(ctx, d, pending, now); err != nil || d.pending.ID != start.ID {
		t.Fatalf("login persistence: %v", err)
	}
	d.failures = map[string]error{"admit": failure}
	d.calls = nil
	if _, err = m.CreateLogin(ctx, d, pending, now); !errors.Is(err, failure) || len(d.calls) != 1 {
		t.Fatalf("admission failure: %v, %v", err, d.calls)
	}
	d.failures = map[string]error{"insert-login": failure}
	if _, err = m.CreateLogin(ctx, d, pending, now); !errors.Is(err, failure) {
		t.Fatalf("insert failure: %v", err)
	}
	d.failures = nil
	for _, code := range []string{"rate_limited", "capacity_exhausted"} {
		d.calls = nil
		d.rejection = code
		_, err = m.CreateLogin(ctx, d, pending, now)
		checkFault(t, err, code)
		if len(d.calls) != 1 || d.calls[0] != "admit" {
			t.Fatalf("rejected login performed writes: %v", d.calls)
		}
	}
	d.rejection = ""
	for _, q := range []url.Values{{}, {"state": {"bad"}}, {"state": {start.State, start.State}}} {
		checkFault(t, ValidateCallback(q, start.BrowserBinding), "unauthenticated")
	}
	checkFault(t, ValidateCallback(url.Values{"state": {start.State}}, "bad"), "unauthenticated")
	if err = ValidateCallback(url.Values{"state": {start.State}}, start.BrowserBinding); err != nil {
		t.Fatal(err)
	}
	d.failures = map[string]error{"consume-login": model.ErrNotFound}
	_, err = m.ConsumeLogin(ctx, d, start.State, start.BrowserBinding, now)
	checkFault(t, err, "unauthenticated")
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("cause lost: %v", err)
	}
	d.failures = nil
	if _, err = m.ConsumeLogin(ctx, d, start.State, start.BrowserBinding, now); err != nil {
		t.Fatal(err)
	}
	checkFault(t, CallbackFailure(failure), "unauthenticated")
	checkFault(t, ValidateProvider("github", "google", failure), "unauthenticated")
	if err = ValidateProvider("github", "github", failure); err != nil {
		t.Fatal(err)
	}
	user, err := m.CompleteLogin(ctx, d, model.User{UniAuthID: "subject"}, now)
	if err != nil || user.ID == "" {
		t.Fatalf("upsert: %#v %v", user, err)
	}
	session, value := m.NewSession(now)
	if !secret.Valid(value, "dnst_") || string(session.TokenHash) != string(secret.Hash(value)) || !session.ExpiresAt.Equal(now.Add(SessionLifetime)) {
		t.Fatal("invalid minted session")
	}
	if err = m.CreateSession(ctx, d, session); err != nil {
		t.Fatal(err)
	}
	credential := secret.Random("dnst_")
	if err := ValidateCredential(model.PATCredential, secret.Random("dnpat_")); err != nil {
		t.Fatalf("PAT credential: %v", err)
	}
	d.principal = model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString()}
	if _, err = m.Authenticate(ctx, d, model.SessionCredential, "bad", now); err == nil {
		t.Fatal("invalid credential accepted")
	}
	if p, err := m.Authenticate(ctx, d, model.SessionCredential, credential, now); err != nil || p != d.principal {
		t.Fatalf("authenticate: %#v %v", p, err)
	}
	d.failures = map[string]error{"authenticate": model.ErrNotFound, "user": model.ErrNotFound}
	_, err = m.Authenticate(ctx, d, model.SessionCredential, credential, now)
	checkFault(t, err, "unauthenticated")
	_, _, err = m.User(ctx, d, d.principal)
	checkFault(t, err, "unauthenticated")
	d.failures = nil
	if _, _, err = m.User(ctx, d, d.principal); err != nil {
		t.Fatal(err)
	}
	checkFault(t, m.Logout(ctx, d, model.Principal{Kind: model.PATCredential}), "forbidden")
	if err = m.Logout(ctx, d, d.principal); err != nil {
		t.Fatal(err)
	}
	if _, err = m.Providers(nil, "identity_timeout", failure); err == nil {
		t.Fatal("discovery failure lost")
	}
	if p, err := m.Providers([]string{"github"}, "", nil); err != nil || len(p) != 1 {
		t.Fatalf("providers: %v %v", p, err)
	}
}

func TestLoginReturnPathByteLimit(t *testing.T) {
	m := NewIdentity("https://example.test/auth/callback")
	for _, value := range []string{
		"/" + strings.Repeat("a", MaxReturnPathBytes-1),
		"/" + strings.Repeat("界", (MaxReturnPathBytes-1)/3),
	} {
		if err := m.ValidateLogin("github", value); err != nil {
			t.Fatalf("valid boundary rejected: %v", err)
		}
		checkFault(t, m.ValidateLogin("github", value+"a"), "invalid_input")
	}
	checkFault(t, m.ValidateLogin("github", "/"+strings.Repeat("a", MaxReturnPathBytes)+"%zz"), "invalid_input")
}

func TestPATLifecycleValidationAndFailures(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	m := NewIdentity("")
	d := &identityDAO{}
	p := model.Principal{Kind: model.SessionCredential, UserID: "123e4567-e89b-12d3-a456-426614174000", CredentialID: uuid.NewString()}
	pat := p
	pat.Kind = model.PATCredential
	failure := errors.New("database failure")
	for _, name := range []string{"", " ", strings.Repeat("a", 101), "bad\x00name", string([]byte{0xff})} {
		_, err := m.CreatePAT(ctx, d, p, CreatePAT{Name: name}, now)
		checkFault(t, err, "invalid_input")
	}
	_, err := m.CreatePAT(ctx, d, pat, CreatePAT{Name: "ok"}, now)
	checkFault(t, err, "forbidden")
	expired := now
	_, err = m.CreatePAT(ctx, d, p, CreatePAT{Name: "ok", ExpiresAt: &expired}, now)
	checkFault(t, err, "invalid_input")
	for _, op := range []string{"lock-session", "cleanup", "insert-pat"} {
		d.failures = map[string]error{op: failure}
		result, err := m.CreatePAT(ctx, d, p, CreatePAT{Name: "ok"}, now)
		if !errors.Is(err, failure) || result.Secret != "" {
			t.Fatalf("%s: %#v %v", op, result, err)
		}
	}
	d.failures = nil
	future := now.Add(time.Hour + 999*time.Nanosecond)
	minted, err := m.CreatePAT(ctx, d, p, CreatePAT{Name: "token", ExpiresAt: &future}, now)
	if err != nil || !secret.Valid(minted.Secret, "dnpat_") || d.pat.UserID != p.UserID || !d.pat.ExpiresAt.Equal(future.Truncate(time.Microsecond)) {
		t.Fatalf("minted PAT: %#v %v", minted, err)
	}
	_, err = m.ListPATs(ctx, d, pat, now)
	checkFault(t, err, "forbidden")
	d.failures = map[string]error{"lock-session": model.ErrNotFound}
	_, err = m.ListPATs(ctx, d, p, now)
	checkFault(t, err, "unauthenticated")
	checkFault(t, m.RevokePAT(ctx, d, p, uuid.NewString(), now), "unauthenticated")
	d.failures = nil
	d.pats = []model.PersonalAccessToken{minted.Credential}
	if list, err := m.ListPATs(ctx, d, p, now); err != nil || len(list) != 1 {
		t.Fatalf("list: %v %v", list, err)
	}
	checkFault(t, m.RevokePAT(ctx, d, pat, uuid.NewString(), now), "forbidden")
	if err = m.RevokePAT(ctx, d, p, "bad", now); err == nil {
		t.Fatal("invalid token id accepted")
	}
	if err = m.RevokePAT(ctx, d, p, strings.ToUpper(minted.Credential.ID), now); err != nil {
		t.Fatal(err)
	}
	input := UpdatePATExpiry{ExpectedUserID: p.UserID}
	_, err = m.UpdatePATExpiry(ctx, d, pat, minted.Credential.ID, input, now)
	checkFault(t, err, "forbidden")
	_, err = m.UpdatePATExpiry(ctx, d, p, "bad", input, now)
	checkFault(t, err, "invalid_input")
	input.ExpectedUserID = "bad"
	_, err = m.UpdatePATExpiry(ctx, d, p, minted.Credential.ID, input, now)
	checkFault(t, err, "invalid_input")
	input.ExpectedUserID = strings.ToUpper(p.UserID)
	_, err = m.UpdatePATExpiry(ctx, d, p, minted.Credential.ID, input, now)
	checkFault(t, err, "invalid_input")
	input.ExpectedUserID = uuid.NewString()
	_, err = m.UpdatePATExpiry(ctx, d, p, minted.Credential.ID, input, now)
	checkFault(t, err, "forbidden")
	input.ExpectedUserID = p.UserID
	input.ExpiresAt = &expired
	_, err = m.UpdatePATExpiry(ctx, d, p, minted.Credential.ID, input, now)
	checkFault(t, err, "invalid_input")
	input.ExpiresAt = nil
	d.failures = map[string]error{"lock-pat": model.ErrNotFound}
	_, err = m.UpdatePATExpiry(ctx, d, p, minted.Credential.ID, input, now)
	checkFault(t, err, "not_found")
	d.failures = map[string]error{"lock-session": model.ErrNotFound}
	_, err = m.UpdatePATExpiry(ctx, d, p, minted.Credential.ID, input, now)
	checkFault(t, err, "not_found")
	d.failures = map[string]error{"lock-pat": failure}
	_, err = m.UpdatePATExpiry(ctx, d, p, minted.Credential.ID, input, now)
	if !errors.Is(err, failure) {
		t.Fatalf("failure lost: %v", err)
	}
	d.failures = nil
	d.pat = minted.Credential
	_, err = m.UpdatePATExpiry(ctx, d, p, minted.Credential.ID, input, now)
	checkFault(t, err, "version_conflict")
	input.ExpectedExpiresAt = d.pat.ExpiresAt
	_, err = m.UpdatePATExpiry(ctx, d, p, minted.Credential.ID, input, now)
	if err != nil || d.pat.ExpiresAt != nil {
		t.Fatalf("expiry update: %#v %v", d.pat, err)
	}
	input.ExpectedExpiresAt = nil
	if _, err = m.UpdatePATExpiry(ctx, d, p, minted.Credential.ID, input, now); err != nil {
		t.Fatalf("no-op expiry: %v", err)
	}
}

func TestLoginCompletionReturnPath(t *testing.T) {
	identity := NewIdentity("https://daynight.example/auth/callback")
	for _, tc := range []struct {
		path string
		want bool
	}{
		{"/auth/complete", false},
		{"/auth/complete?next=%2Fprojects#section", false},
		{"/auth/complete/child", false},
		{"/auth/other/../complete/child", false},
		{"/auth/%63omplete", false},
		{"/auth/complete%2Fchild", false},
		{"/x%2Fsomething/../auth/complete?returnPath=%2F", false},
		{"/x%2Fsomething/%2e%2e/auth/complete", false},
		{"/x%2Fsomething/.%2E/auth/complete/child", false},
		{"/foo#fragment/../auth/complete", false},
		{"/foo#fragment/../auth/complete/child", false},
		{"/foo?x=1#fragment/../auth/complete", true},
		{"%2Ffoo/../complete?returnPath=%2F", false},
		{"%2Ffoo/%2e%2e/complete", false},
		{"/x%2Fsomething/../auth/completed", true},
		{"%2Ffoo/../completed", true},
		{"/auth/completed", true},
		{"/", true},
		{"/setup?from=login#instructions", true},
		{"/assets/app.js?version=1#fragment", true},
		{"/assets/%FF?x=1#fragment", true},
		{"/%C3", true},
		{"%2Fprojects", true},
		{"/projects?sort=recent#current", true},
	} {
		t.Run(tc.path, func(t *testing.T) {
			_, pending, err := identity.StartLogin("github", tc.path, time.Now())
			if tc.want {
				if err != nil || pending.ReturnPath != tc.path {
					t.Fatalf("return path %q: pending=%q err=%v", tc.path, pending.ReturnPath, err)
				}
			} else {
				checkFault(t, err, "invalid_input")
			}
		})
	}
}

func TestLoginCompletionReturnPathUsesCallbackDirectory(t *testing.T) {
	for _, tc := range []struct {
		callback, target string
		want             bool
	}{
		{"/auth/callback", "%2Ffoo/../complete?returnPath=%2F", false},
		{"/auth/callback", "%2Ffoo/%2e%2e/complete/child", false},
		{"/custom/callback", "%2Ffoo/../complete?returnPath=%2F", true},
		{"/custom/callback", "%2Ffoo/%2e%2e/complete/child", true},
		{"/custom/callback", "%2Ffoo/../../auth/complete", false},
		{"/custom/callback", "%2Ffoo/%2e%2e/%2e%2e/auth/complete", false},
		{"/custom/callback", "%2Fprojects?view=1#part", true},
	} {
		t.Run(tc.callback+" -> "+tc.target, func(t *testing.T) {
			identity := NewIdentity("https://daynight.example" + tc.callback)
			_, pending, err := identity.StartLogin("github", tc.target, time.Now())
			if tc.want {
				if err != nil || pending.ReturnPath != tc.target {
					t.Fatalf("return path %q: pending=%q err=%v", tc.target, pending.ReturnPath, err)
				}
			} else {
				checkFault(t, err, "invalid_input")
			}
		})
	}
}

func TestOAuthConsentLoginReturn(t *testing.T) {
	identity := NewIdentity("https://daynight.example/api/v1/auth/callback")
	for _, tc := range []struct {
		path string
		want bool
	}{
		{"/oauth/consent?request=1d455112-e730-45e8-a4c1-749f053fd279", true},
		{"/oauth/consent?request=invalid", false},
		{"/oauth/consent?request=1d455112-e730-45e8-a4c1-749f053fd279&request=1d455112-e730-45e8-a4c1-749f053fd279", false},
		{"/oauth/consent?request=1d455112-e730-45e8-a4c1-749f053fd279&next=https%3A%2F%2Fevil.example", false},
		{"/oauth/authorize?client_id=client", false},
		{"/oauth/consent/../authorize", false},
		{"/oauth/consent?request=1d455112-e730-45e8-a4c1-749f053fd279#fragment", false},
	} {
		if got := identity.validReturnPath(tc.path); got != tc.want {
			t.Errorf("%q: got %v", tc.path, got)
		}
	}
}
