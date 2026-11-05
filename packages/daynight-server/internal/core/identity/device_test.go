package identity

import (
	"context"
	"crypto/rand"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type failedRandomSource struct{ failure error }

func (s failedRandomSource) Read([]byte) (int, error) { return 0, s.failure }

func TestDeviceRateAndStart(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	m := NewIdentity("")
	d := &identityDAO{}
	failure := errors.New("database failure")
	for _, op := range []string{"prune-rate", "increment-rate"} {
		d.failures = map[string]error{op: failure}
		if err := m.DeviceRate(ctx, d, "operation", "actor", 3, 2, now); !errors.Is(err, failure) {
			t.Fatalf("%s: %v", op, err)
		}
	}
	d.failures = nil
	d.attempts = 4
	checkFault(t, m.DeviceRate(ctx, d, "operation", "actor", 3, 2, now), "rate_limited")
	d.attempts = 1
	if err := m.DeviceRate(ctx, d, "operation", "actor", 3, 2, now); err != nil {
		t.Fatal(err)
	}
	_, err := m.StartDevice(ctx, d, "bad", now)
	checkGrant(t, err, "invalid_client")
	func() {
		originalRandom := rand.Reader
		defer func() { rand.Reader = originalRandom }()
		rand.Reader = failedRandomSource{failure: failure}
		_, err = m.StartDevice(ctx, d, DeviceClientID, now)
	}()
	if !errors.Is(err, failure) {
		t.Fatalf("random source error lost: %v", err)
	}
	for _, op := range []string{"prune-device", "insert-device"} {
		d.failures = map[string]error{op: failure}
		result, err := m.StartDevice(ctx, d, DeviceClientID, now)
		if !errors.Is(err, failure) || result.DeviceCode != "" {
			t.Fatalf("%s: %#v %v", op, result, err)
		}
	}
	d.failures = nil
	result, err := m.StartDevice(ctx, d, DeviceClientID, now)
	if err != nil || !secret.Valid(result.DeviceCode, "") || len(result.UserCode) != 11 || !result.ExpiresAt.Equal(now.Add(DeviceLifetime)) || string(d.device.DeviceCodeHash) != string(secret.Hash(result.DeviceCode)) {
		t.Fatalf("start: %#v %v", result, err)
	}
	for _, value := range []string{"short", "AAAAAAAAAA"} {
		if _, err := NormalizeDeviceCode(value); err == nil {
			t.Fatal("invalid user code accepted")
		}
	}
	if code, err := NormalizeDeviceCode(" bcdfg - hjklm "); err != nil || code != "BCDFGHJKLM" {
		t.Fatalf("normalize: %q %v", code, err)
	}
}

func TestDeviceInspectionAndDecision(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC()
	m := NewIdentity("")
	p := model.Principal{Kind: model.SessionCredential, UserID: "123e4567-e89b-12d3-a456-426614174000"}
	bad := p
	bad.Kind = model.PATCredential
	d := &identityDAO{device: model.DeviceAuthorization{ID: uuid.NewString(), UserCode: "BCDFGHJKLM", Status: "pending", ExpiresAt: now.Add(time.Minute)}}
	failure := errors.New("database failure")
	_, err := m.InspectDevice(ctx, d, bad, d.device.UserCode, now)
	checkFault(t, err, "forbidden")
	_, err = m.InspectDevice(ctx, d, p, "bad", now)
	checkFault(t, err, "invalid_input")
	for _, op := range []string{"lock-session", "user-code"} {
		d.failures = map[string]error{op: model.ErrNotFound}
		_, err = m.InspectDevice(ctx, d, p, d.device.UserCode, now)
		checkFault(t, err, "not_found")
	}
	d.failures = map[string]error{"user-code": failure}
	_, err = m.InspectDevice(ctx, d, p, d.device.UserCode, now)
	if !errors.Is(err, failure) {
		t.Fatalf("lookup failure lost: %v", err)
	}
	d.failures = nil
	found, err := m.InspectDevice(ctx, d, p, d.device.UserCode, now)
	if err != nil || found.ID != d.device.ID {
		t.Fatalf("inspection: %#v %v", found, err)
	}
	if got := m.DeviceInspection(found, now); got.Status != "pending" || got.UserCode != "BCDFG-HJKLM" {
		t.Fatalf("inspection: %#v", got)
	}
	if got := m.DeviceInspection(found, found.ExpiresAt); got.Status != "expired" {
		t.Fatalf("expiry: %#v", got)
	}
	found.Status = "consumed"
	if got := m.DeviceInspection(found, found.ExpiresAt); got.Status != "consumed" {
		t.Fatalf("consumed: %#v", got)
	}
	for _, in := range []struct {
		p                              model.Principal
		code, decision, user, expected string
	}{{bad, d.device.UserCode, "approve", p.UserID, "forbidden"}, {p, "bad", "approve", p.UserID, "invalid_input"}, {p, d.device.UserCode, "approve", "bad", "invalid_input"}, {p, d.device.UserCode, "approve", strings.ToUpper(p.UserID), "invalid_input"}, {p, d.device.UserCode, "approve", uuid.NewString(), "forbidden"}, {p, d.device.UserCode, "wrong", p.UserID, "invalid_input"}} {
		checkFault(t, m.DecideDevice(ctx, d, in.p, in.code, in.decision, in.user, now), in.expected)
	}
	d.failures = map[string]error{"lock-session": model.ErrNotFound}
	checkFault(t, m.DecideDevice(ctx, d, p, d.device.UserCode, "approve", p.UserID, now), "not_found")
	d.failures = map[string]error{"user-code": model.ErrNotFound}
	checkFault(t, m.DecideDevice(ctx, d, p, d.device.UserCode, "approve", p.UserID, now), "not_found")
	d.failures = nil
	d.device.ExpiresAt = now
	checkFault(t, m.DecideDevice(ctx, d, p, d.device.UserCode, "approve", p.UserID, now), "invalid_transition")
	d.device.ExpiresAt = now.Add(time.Minute)
	d.device.Status = "denied"
	checkFault(t, m.DecideDevice(ctx, d, p, d.device.UserCode, "approve", p.UserID, now), "invalid_transition")
	d.device.Status = "pending"
	if err = m.DecideDevice(ctx, d, p, d.device.UserCode, "deny", p.UserID, now); err != nil {
		t.Fatal(err)
	}
	d.failures = map[string]error{"decision": failure}
	if err = m.DecideDevice(ctx, d, p, d.device.UserCode, "approve", p.UserID, now); !errors.Is(err, failure) {
		t.Fatalf("decision error lost: %v", err)
	}
}

func TestDeviceRedemptionAndLogout(t *testing.T) {
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	m := NewIdentity("")
	code := secret.Random("")
	user := uuid.NewString()
	d := &identityDAO{device: model.DeviceAuthorization{ID: uuid.NewString(), Status: "pending", UserID: &user, ExpiresAt: now.Add(time.Minute), NextPollAt: now.Add(time.Second)}}
	failure := errors.New("database failure")
	for _, in := range []struct{ client, grant, code, name, want string }{{"bad", DeviceGrantType, code, "host", "invalid_client"}, {DeviceClientID, "bad", code, "host", "unsupported_grant_type"}, {DeviceClientID, DeviceGrantType, code, "", "invalid_request"}, {DeviceClientID, DeviceGrantType, code, "bad\nname", "invalid_request"}, {DeviceClientID, DeviceGrantType, "bad", "host", "invalid_grant"}} {
		_, err := m.RedeemDevice(ctx, d, in.client, in.grant, in.code, in.name, now)
		checkGrant(t, err, in.want)
	}
	d.failures = map[string]error{"device-hash": model.ErrNotFound}
	_, err := m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, "host", now)
	checkGrant(t, err, "invalid_grant")
	d.failures = map[string]error{"device-hash": failure}
	if _, err = m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, "host", now); !errors.Is(err, failure) {
		t.Fatalf("lock failure lost: %v", err)
	}
	d.failures = nil
	for _, state := range []struct {
		status string
		expiry time.Time
		want   string
	}{{"consumed", now.Add(time.Minute), "invalid_grant"}, {"pending", now, "expired_token"}, {"denied", now.Add(time.Minute), "access_denied"}} {
		d.device.Status = state.status
		d.device.ExpiresAt = state.expiry
		result, err := m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, "host", now)
		checkGrant(t, err, state.want)
		if result.Secret != "" {
			t.Fatal("failed grant returned secret")
		}
	}
	d.device.Status = "pending"
	d.device.ExpiresAt = now.Add(time.Minute)
	_, err = m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, "host", now)
	checkGrant(t, err, "slow_down")
	d.failures = map[string]error{"poll": failure}
	if _, err = m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, "host", now); !errors.Is(err, failure) {
		t.Fatalf("poll failure: %v", err)
	}
	d.failures = nil
	d.device.NextPollAt = now
	_, err = m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, "host", now)
	checkGrant(t, err, "authorization_pending")
	d.failures = map[string]error{"poll": failure}
	if _, err = m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, "host", now); !errors.Is(err, failure) {
		t.Fatalf("pending failure: %v", err)
	}
	d.device.Status = "approved"
	for _, op := range []string{"insert-pat", "consume-device"} {
		d.failures = map[string]error{op: failure}
		result, err := m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, "host", now)
		if !errors.Is(err, failure) || result.Secret != "" {
			t.Fatalf("%s: %#v %v", op, result, err)
		}
	}
	d.failures = nil
	result, err := m.RedeemDevice(ctx, d, DeviceClientID, DeviceGrantType, code, strings.Repeat("界", 90), now)
	if err != nil || !secret.Valid(result.Secret, "dnpat_") || d.pat.UserID != user || len([]rune(result.Credential.Name)) != len([]rune("Daynight CLI ("))+85+1 {
		t.Fatalf("redeem: %#v %v", result, err)
	}
	checkFault(t, m.LogoutDevice(ctx, d, model.Principal{Kind: model.SessionCredential}), "forbidden")
	if err = m.LogoutDevice(ctx, d, model.Principal{Kind: model.PATCredential, UserID: user}); err != nil {
		t.Fatal(err)
	}
}
