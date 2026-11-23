package identity

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type scopedDeviceDAO struct {
	*identityDAO
	fresh        time.Time
	selection    []scopepolicy.ScopeID
	status, user string
}

func (d *scopedDeviceDAO) FreshPATTime(context.Context, time.Time) (time.Time, error) {
	return d.fresh, d.hit("fresh-pat-time")
}
func (d *scopedDeviceDAO) SetScopedDeviceDecision(_ context.Context, id, status, user string, selected []scopepolicy.ScopeID) error {
	if id != d.device.ID {
		return errors.New("wrong device")
	}
	d.status, d.user, d.selection = status, user, selected
	return d.hit("scoped-decision")
}

func TestScopedDeviceDecisionUsesPostLockTimeAndSelection(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	p := model.Principal{Kind: model.SessionCredential, UserID: "123e4567-e89b-12d3-a456-426614174000"}
	base := model.DeviceAuthorization{ID: "device", UserCode: "BCDFGHJKLM", Status: "pending", ExpiresAt: now.Add(time.Second)}
	module := NewIdentity("")
	for _, tc := range []struct {
		name, decision, status, fault string
		fresh                         time.Time
		selected, want                []scopepolicy.ScopeID
	}{
		{"approval", "approve", "approved", "", now, []scopepolicy.ScopeID{"task:read", "project:read"}, []scopepolicy.ScopeID{"project:read", "task:read"}},
		{"denial", "deny", "denied", "", now, nil, nil},
		{"empty", "approve", "", "invalid_input", now, nil, nil},
		{"duplicate", "approve", "", "invalid_input", now, []scopepolicy.ScopeID{"task:read", "task:read"}, nil},
		{"expires while locked", "approve", "", "invalid_transition", base.ExpiresAt, []scopepolicy.ScopeID{"task:read"}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := &scopedDeviceDAO{identityDAO: &identityDAO{device: base}, fresh: tc.fresh}
			err := module.DecideDeviceScoped(ctx, d, d, p, base.UserCode, tc.decision, p.UserID, tc.selected, now)
			if tc.fault != "" {
				checkFault(t, err, tc.fault)
				if d.status != "" {
					t.Fatal("rejected decision was written")
				}
				return
			}
			if err != nil || d.status != tc.status || d.user != p.UserID || !reflect.DeepEqual(d.selection, tc.want) {
				t.Fatalf("decision=%s %s %v error=%v", d.status, d.user, d.selection, err)
			}
			if !reflect.DeepEqual(d.calls, []string{"lock-session", "user-code", "fresh-pat-time", "lock-session", "scoped-decision"}) {
				t.Fatalf("order %v", d.calls)
			}
		})
	}
}

func TestScopedDeviceRedemption(t *testing.T) {
	ctx := t.Context()
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	user := "123e4567-e89b-12d3-a456-426614174000"
	code := secret.Random("")
	base := model.DeviceAuthorization{ID: "device", Status: "approved", UserID: &user, ExpiresAt: now.Add(time.Minute), NextPollAt: now, ApprovedScopes: []scopepolicy.ScopeID{"project:read", "task:read"}}
	module := NewIdentity("")
	for _, tc := range []struct {
		name, status, grant string
		fresh               time.Time
		scopes              []scopepolicy.ScopeID
	}{
		{"approved", "approved", "", now, base.ApprovedScopes},
		{"consumed", "consumed", "invalid_grant", now, base.ApprovedScopes},
		{"denied", "denied", "access_denied", now, nil},
		{"pending", "pending", "authorization_pending", now, nil},
		{"expired while locked", "approved", "expired_token", base.ExpiresAt, base.ApprovedScopes},
	} {
		t.Run(tc.name, func(t *testing.T) {
			device := base
			device.Status, device.ApprovedScopes = tc.status, tc.scopes
			d := &scopedDeviceDAO{identityDAO: &identityDAO{device: device}, fresh: tc.fresh}
			got, err := module.RedeemDeviceScoped(ctx, d, d, DeviceClientID, DeviceGrantType, code, "machine", now)
			if tc.grant != "" {
				checkGrant(t, err, tc.grant)
				if d.pat.ID != "" {
					t.Fatal("rejected redemption minted a token")
				}
				return
			}
			if err != nil || got.Credential.UserID != user || got.Credential.ScopePolicy == nil || !reflect.DeepEqual(got.Credential.ScopePolicy.Scopes(), base.ApprovedScopes) || d.pat.ID != got.Credential.ID {
				t.Fatalf("mint=%+v err=%v", got.Credential, err)
			}
			if !reflect.DeepEqual(d.calls, []string{"device-hash", "fresh-pat-time", "insert-pat", "consume-device"}) {
				t.Fatalf("order %v", d.calls)
			}
		})
	}
	for _, selected := range [][]scopepolicy.ScopeID{nil, {"task:read", "task:read"}} {
		d := &scopedDeviceDAO{identityDAO: &identityDAO{device: base}, fresh: now}
		d.device.ApprovedScopes = selected
		if _, err := module.RedeemDeviceScoped(ctx, d, d, DeviceClientID, DeviceGrantType, code, "machine", now); err == nil || d.pat.ID != "" {
			t.Fatalf("invalid policy produced token: %v", err)
		}
	}
}

func TestScopedDeviceFailures(t *testing.T) {
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	user := "123e4567-e89b-12d3-a456-426614174000"
	p := model.Principal{Kind: model.SessionCredential, UserID: user}
	base := model.DeviceAuthorization{ID: "device", UserCode: "BCDFGHJKLM", Status: "pending", ExpiresAt: now.Add(time.Minute), NextPollAt: now}
	module := NewIdentity("")
	failure := errors.New("storage failed")
	for _, op := range []string{"lock-session", "user-code", "fresh-pat-time", "scoped-decision"} {
		t.Run("decision "+op, func(t *testing.T) {
			d := &scopedDeviceDAO{identityDAO: &identityDAO{device: base, failures: map[string]error{op: failure}}, fresh: now}
			err := module.DecideDeviceScoped(t.Context(), d, d, p, base.UserCode, "approve", user, []scopepolicy.ScopeID{"task:read"}, now)
			if !errors.Is(err, failure) {
				t.Fatalf("failure lost: %v", err)
			}
		})
	}
	d := &scopedDeviceDAO{identityDAO: &identityDAO{device: base}, fresh: now}
	checkFault(t, module.DecideDeviceScoped(t.Context(), d, d, p, "bad", "approve", user, []scopepolicy.ScopeID{"task:read"}, now), "invalid_input")
	checkFault(t, module.DecideDeviceScoped(t.Context(), d, d, p, base.UserCode, "deny", user, []scopepolicy.ScopeID{"task:read"}, now), "invalid_input")
	d.device.Status = "approved"
	checkFault(t, module.DecideDeviceScoped(t.Context(), d, d, p, base.UserCode, "approve", user, []scopepolicy.ScopeID{"task:read"}, now), "invalid_transition")
	code := secret.Random("")
	approved := base
	approved.Status = "approved"
	approved.UserID = &user
	approved.ApprovedScopes = []scopepolicy.ScopeID{"task:read"}
	for _, op := range []string{"device-hash", "fresh-pat-time", "insert-pat", "consume-device"} {
		t.Run("redemption "+op, func(t *testing.T) {
			d := &scopedDeviceDAO{identityDAO: &identityDAO{device: approved, failures: map[string]error{op: failure}}, fresh: now}
			if _, err := module.RedeemDeviceScoped(t.Context(), d, d, DeviceClientID, DeviceGrantType, code, "machine", now); !errors.Is(err, failure) {
				t.Fatalf("failure lost: %v", err)
			}
		})
	}
	d = &scopedDeviceDAO{identityDAO: &identityDAO{device: approved, failures: map[string]error{"device-hash": model.ErrNotFound}}, fresh: now}
	_, err := module.RedeemDeviceScoped(t.Context(), d, d, DeviceClientID, DeviceGrantType, code, "machine", now)
	checkGrant(t, err, "invalid_grant")
	_, err = module.RedeemDeviceScoped(t.Context(), d, d, "bad", DeviceGrantType, code, "machine", now)
	checkGrant(t, err, "invalid_client")
	d = &scopedDeviceDAO{identityDAO: &identityDAO{device: approved}, fresh: now}
	d.device.NextPollAt = now.Add(time.Second)
	_, err = module.RedeemDeviceScoped(t.Context(), d, d, DeviceClientID, DeviceGrantType, code, "machine", now)
	checkGrant(t, err, "slow_down")
	d.failures = map[string]error{"poll": failure}
	_, err = module.RedeemDeviceScoped(t.Context(), d, d, DeviceClientID, DeviceGrantType, code, "machine", now)
	if !errors.Is(err, failure) {
		t.Fatalf("poll failure lost: %v", err)
	}
	d.device.NextPollAt = now
	d.device.Status = "pending"
	_, err = module.RedeemDeviceScoped(t.Context(), d, d, DeviceClientID, DeviceGrantType, code, "machine", now)
	if !errors.Is(err, failure) {
		t.Fatalf("pending poll failure lost: %v", err)
	}
	d.failures = nil
	d.device.Status = "approved"
	d.device.UserID = nil
	_, err = module.RedeemDeviceScoped(t.Context(), d, d, DeviceClientID, DeviceGrantType, code, "machine", now)
	if err == nil {
		t.Fatal("missing owner accepted")
	}
}
