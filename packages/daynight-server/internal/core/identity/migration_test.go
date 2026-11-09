package identity

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestLoginOriginalInputsAndMaterial(t *testing.T) {
	m := NewIdentity("http://daynight.test:8787/auth/callback")
	now := time.Now().UTC()
	for _, provider := range []string{"", "Microsoft", "oidc", "github\x00"} {
		checkFault(t, m.ValidateLogin(provider, "/"), "invalid_input")
	}
	for _, path := range []string{"https://evil.example/path", "//evil.example", "relative", "/\\evil", "/line\rbreak", "/line\nbreak", "/bad\x00", "/bad\xff", "/%5Cevil", "/%0Dheader", "/%00bad", "/%2fexample.com", "/api/v1/auth/login", "/api/v1/%61uth/callback", "/login", "/login?returnPath=/projects", "/login/child", "/other/../login", "/%6cogin", "/%zz", "/auth/callback", "/auth/callback?code=value", "/auth/callback/child", "/other/../auth/callback", "/auth/%63allback"} {
		checkFault(t, m.ValidateLogin("microsoft", path), "invalid_input")
	}
	for _, provider := range []string{"microsoft", "google", "github"} {
		for _, path := range []string{"", "/", "/projects", "/test-sessions/10000000-0000-0000-0000-000000000001", "/projects/abc?view=graph#tasks", "/%E4%B8%AD%E6%96%87", "/login-help"} {
			start, pending, err := m.StartLogin(provider, path, now)
			if err != nil {
				t.Fatalf("valid provider/path: %q %q %v", provider, path, err)
			}
			if _, err := uuid.Parse(start.ID); err != nil {
				t.Fatal(err)
			}
			wantPath := path
			if path == "" {
				wantPath = "/projects"
			}
			want := model.LoginTransaction{ID: start.ID, StateHash: secret.Hash(start.State), BrowserBindingHash: secret.Hash(start.BrowserBinding), Provider: provider, ReturnPath: wantPath, ExpiresAt: now.Add(LoginLifetime)}
			if !secret.Valid(start.State, "") || !secret.Valid(start.BrowserBinding, "") || start.State == start.BrowserBinding || !start.ExpiresAt.Equal(want.ExpiresAt) || !reflect.DeepEqual(pending, want) {
				t.Fatalf("login material: %#v %#v", start, pending)
			}
		}
	}
	session, value := m.NewSession(now)
	if _, err := uuid.Parse(session.ID); err != nil {
		t.Fatal(err)
	}
	want := model.Session{ID: session.ID, TokenHash: secret.Hash(value), CreatedAt: now, ExpiresAt: now.Add(SessionLifetime)}
	if !secret.Valid(value, "dnst_") || !reflect.DeepEqual(session, want) {
		t.Fatalf("session material: %#v", session)
	}
}

func TestPATOriginalBoundsAndMetadata(t *testing.T) {
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	m := NewIdentity("")
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	for _, name := range []string{"", " \t\n", "bad\x00name", "bad\xffname", strings.Repeat("界", 101)} {
		d := &identityDAO{}
		_, err := m.CreatePAT(ctx, d, p, CreatePAT{Name: name}, now)
		checkFault(t, err, "invalid_input")
		if len(d.calls) != 0 {
			t.Fatal("invalid name touched DAO")
		}
	}
	for _, days := range []int{-1, 0, 1, 365, 3650} {
		expiry := now.Add(time.Duration(days) * 24 * time.Hour)
		name := strings.Repeat("界", 100)
		if days == 1 {
			name = " Build agent "
		}
		d := &identityDAO{}
		minted, err := m.CreatePAT(ctx, d, p, CreatePAT{Name: name, ExpiresAt: &expiry}, now)
		if days <= 0 {
			checkFault(t, err, "invalid_input")
			if len(d.calls) != 0 {
				t.Fatal("invalid expiry touched DAO")
			}
			continue
		}
		if err != nil {
			t.Fatal(err)
		}
		want := model.PersonalAccessToken{ID: minted.Credential.ID, UserID: p.UserID, Name: name, TokenHash: secret.Hash(minted.Secret), CreatedAt: now, ExpiresAt: &expiry}
		if !secret.Valid(minted.Secret, "dnpat_") || !reflect.DeepEqual(minted.Credential, want) || !reflect.DeepEqual(d.pat, want) || !reflect.DeepEqual(d.calls, []string{"lock-session", "cleanup", "insert-pat"}) {
			t.Fatalf("PAT material=%#v stored=%#v calls=%v", minted, d.pat, d.calls)
		}
	}
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential, "unknown"} {
		for _, value := range []string{"", "wrong", "dnst_" + strings.Repeat("!", 43), "dnpat_" + strings.Repeat("A", 42), "dnst_" + strings.Repeat("A", 43) + "="} {
			checkFault(t, ValidateCredential(kind, value), "unauthenticated")
		}
	}
}

type expiryReceiver struct {
	*identityDAO
	ctx       context.Context
	principal model.Principal
	id        string
	now       time.Time
	result    model.PersonalAccessToken
	writes    int
}

func (d *expiryReceiver) LockSession(ctx context.Context, p model.Principal, now time.Time) error {
	if ctx != d.ctx || p != d.principal || now != d.now {
		panic("wrong session capability input")
	}
	return d.identityDAO.LockSession(ctx, p, now)
}
func (d *expiryReceiver) LockActivePAT(ctx context.Context, user, id string, now time.Time) (model.PersonalAccessToken, error) {
	if ctx != d.ctx || user != d.principal.UserID || id != d.id || now != d.now {
		panic("wrong active PAT input")
	}
	return d.identityDAO.LockActivePAT(ctx, user, id, now)
}
func (d *expiryReceiver) SetPATExpiry(ctx context.Context, id string, value *time.Time) (model.PersonalAccessToken, error) {
	if ctx != d.ctx || id != d.id || !equalTokenExpiry(value, d.result.ExpiresAt) {
		panic("wrong expiry write")
	}
	d.writes++
	return d.result, d.hit("set-expiry")
}

func TestPATExpiryOriginalObservationAndNoop(t *testing.T) {
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	p := model.Principal{Kind: model.SessionCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
	m := NewIdentity("")
	target := now.Add(time.Hour + 987*time.Nanosecond).In(time.FixedZone("UTC+08", 8*60*60))
	normalized := target.UTC().Truncate(time.Microsecond)
	current := model.PersonalAccessToken{ID: uuid.NewString(), UserID: p.UserID, Name: "Editable", CreatedAt: now.Add(-time.Hour)}
	for _, tc := range []struct {
		name                       string
		current, desired, expected *time.Time
		conflict                   bool
		writes                     int
	}{
		{name: "extend", desired: &target, writes: 1}, {name: "stale observed null", current: &normalized, desired: &target, conflict: true},
		{name: "matching expiry noop", current: &normalized, desired: &target, expected: &normalized}, {name: "remove", current: &normalized, expected: &normalized, writes: 1}, {name: "matching null noop"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			stored := current
			stored.ExpiresAt = tc.current
			result := current
			if tc.desired != nil {
				result.ExpiresAt = &normalized
			}
			d := &expiryReceiver{identityDAO: &identityDAO{pat: stored}, ctx: ctx, principal: p, id: current.ID, now: now, result: result}
			got, err := m.UpdatePATExpiry(ctx, d, p, current.ID, UpdatePATExpiry{ExpiresAt: tc.desired, ExpectedExpiresAt: tc.expected, ExpectedUserID: p.UserID}, now)
			if tc.conflict {
				checkFault(t, err, "version_conflict")
				if !reflect.DeepEqual(got, model.PersonalAccessToken{}) {
					t.Fatal("conflict returned result")
				}
			} else if err != nil || !reflect.DeepEqual(got, result) {
				t.Fatalf("expiry result=%#v want=%#v %v", got, result, err)
			}
			if d.writes != tc.writes {
				t.Fatalf("writes=%d want=%d", d.writes, tc.writes)
			}
		})
	}
	failure := errors.New("write failure")
	d := &identityDAO{pat: current, failures: map[string]error{"set-expiry": failure}}
	_, err := m.UpdatePATExpiry(ctx, d, p, current.ID, UpdatePATExpiry{ExpiresAt: &target, ExpectedUserID: p.UserID}, now)
	if !errors.Is(err, failure) {
		t.Fatalf("expiry cause lost: %v", err)
	}
}

func TestDeviceOriginalNamesAndInvalidNamePreservesGrant(t *testing.T) {
	m := NewIdentity("")
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	owner := uuid.NewString()
	code := secret.Random("")
	for _, input := range []struct{ hostname, display string }{
		{"workstation", "workstation"}, {"开发工作站", "开发工作站"}, {strings.Repeat("a", 85), strings.Repeat("a", 85)},
		{strings.Repeat("界", 84) + "🖥️", strings.Repeat("界", 84) + "🖥"}, {strings.Repeat("界", 255), strings.Repeat("界", 85)},
	} {
		d := &identityDAO{device: model.DeviceAuthorization{ID: uuid.NewString(), Status: "approved", UserID: &owner, ExpiresAt: now.Add(time.Hour), NextPollAt: now}}
		got, err := m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, input.hostname, now)
		if err != nil || got.Credential.Name != "Daynight CLI ("+input.display+")" || got.Credential.ExpiresAt != nil || !secret.Valid(got.Secret, "dnpat_") || !reflect.DeepEqual(got.Credential.TokenHash, secret.Hash(got.Secret)) || d.pat.UserID != owner || !got.Credential.CreatedAt.Equal(now) || !reflect.DeepEqual(d.calls, []string{"device-hash", "insert-pat", "consume-device"}) {
			t.Fatalf("mint=%#v DAO=%#v %v", got, d, err)
		}
	}
	d := &identityDAO{device: model.DeviceAuthorization{ID: uuid.NewString(), Status: "approved", UserID: &owner, ExpiresAt: now.Add(time.Hour), NextPollAt: now}}
	for _, name := range []string{"", " \u2003", "\xff", "host\x00name", "host\nname", "host\u0085name", strings.Repeat("a", 256)} {
		got, err := m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, name, now)
		checkGrant(t, err, "invalid_request")
		if got.Secret != "" || len(d.calls) != 0 {
			t.Fatal("invalid name touched grant or issued credential")
		}
	}
	if _, err := m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, "workstation", now); err != nil {
		t.Fatalf("valid name could not redeem: %v", err)
	}
	for _, code := range []string{"", "ABC", "AAAAAAAAAA", "界界界界界"} {
		if _, err := NormalizeDeviceCode(code); err == nil {
			t.Fatalf("invalid code %q accepted", code)
		}
	}
	if code, err := NormalizeDeviceCode(" bcdfg\t-hjklm "); err != nil || code != "BCDFGHJKLM" {
		t.Fatalf("normalization=%q %v", code, err)
	}
}

func TestDeviceOriginalDecisionAndPersistentPollRules(t *testing.T) {
	m := NewIdentity("")
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := "123e4567-e89b-12d3-a456-426614174000"
	p := model.Principal{Kind: model.SessionCredential, UserID: user}
	for _, status := range []string{"approved", "denied", "consumed"} {
		d := &identityDAO{device: model.DeviceAuthorization{ID: uuid.NewString(), UserID: &user, Status: status, ExpiresAt: now.Add(time.Hour)}}
		checkFault(t, m.DecideDevice(ctx, d, p, "BCDFG-HJKLM", "deny", user, now), "invalid_transition")
		if !reflect.DeepEqual(d.calls, []string{"lock-session", "user-code"}) {
			t.Fatalf("terminal decision wrote: %v", d.calls)
		}
	}
	for _, decision := range []string{"approve", "deny"} {
		d := &identityDAO{}
		checkFault(t, m.DecideDevice(ctx, d, p, "BCDFG-HJKLM", decision, uuid.NewString(), now), "forbidden")
		if len(d.calls) != 0 {
			t.Fatal("changed account touched grant")
		}
	}
	for _, op := range []struct {
		name, actor   string
		global, local int
	}{{"device-create", "client-source", 120, 30}, {"device-lookup", user, 120, 12}} {
		d := &rateReceiver{t: t, ctx: ctx, now: now, operation: op.name, actor: op.actor, limits: []int{op.global, op.local}}
		if err := m.DeviceRate(ctx, d, op.name, op.actor, op.global, op.local, now); err != nil {
			t.Fatal(err)
		}
		if d.calls != 2 {
			t.Fatalf("rate buckets=%d", d.calls)
		}
	}
}

type rateReceiver struct {
	store.IdentityDAO
	t                *testing.T
	ctx              context.Context
	now              time.Time
	operation, actor string
	limits           []int
	calls            int
}

func (d *rateReceiver) PruneDeviceRates(ctx context.Context, now time.Time) error {
	if ctx != d.ctx || now != d.now || d.calls != 0 {
		d.t.Fatal("rate prune arguments/order")
	}
	return nil
}
func (d *rateReceiver) IncrementDeviceRate(ctx context.Context, b model.DeviceRateBucket, now time.Time) (int, error) {
	d.t.Helper()
	if ctx != d.ctx || now != d.now || d.calls >= 2 {
		d.t.Fatal("unexpected rate bucket")
	}
	key := d.operation
	if d.calls == 1 {
		key += ":" + d.actor
	}
	want := model.DeviceRateBucket{Hash: secret.Hash(key), Limit: d.limits[d.calls]}
	if !reflect.DeepEqual(b, want) {
		d.t.Fatalf("rate bucket=%#v want=%#v", b, want)
	}
	d.calls++
	return 1, nil
}
