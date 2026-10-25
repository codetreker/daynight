package service

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
)

func requireDeviceError(t *testing.T, err error, code string) {
	t.Helper()
	var failure *DeviceGrantError
	if !errors.As(err, &failure) || failure.Code != code || failure.Error() == "" {
		t.Fatalf("expected device error %s, got %v", code, err)
	}
}
func startDevice(t *testing.T, f *identityFixture) DeviceStart {
	t.Helper()
	d, err := f.identity.StartDevice(context.Background(), DeviceClientID, "client-source")
	if err != nil {
		t.Fatal(err)
	}
	return d
}
func redeemDevice(f *identityFixture, d DeviceStart) (MintedPAT, error) {
	return f.identity.RedeemDevice(context.Background(), DeviceClientID, DeviceGrantType, d.DeviceCode, "workstation")
}

func TestDeviceAuthorizationLifecycle(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	alice := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	bob := identityPrincipal(t, f, completeIdentityLogin(t, f, "bob"))
	d := startDevice(t, f)
	if !validSecret(d.DeviceCode, "") || len(d.UserCode) != 11 || !d.ExpiresAt.Equal(f.now.Add(DeviceLifetime)) {
		t.Fatal("invalid device material")
	}
	var stored []byte
	if err := f.database.Pool.QueryRow(ctx, `SELECT device_code_hash FROM device_authorizations`).Scan(&stored); err != nil || !bytes.Equal(stored, secretHash(d.DeviceCode)) {
		t.Fatalf("device secret was not hashed: %v", err)
	}
	inspected, err := f.identity.InspectDevice(ctx, alice, " "+strings.ToLower(d.UserCode)+" ")
	if err != nil || inspected.Status != "pending" || inspected.UserCode != d.UserCode || !inspected.ExpiresAt.Equal(d.ExpiresAt) {
		t.Fatalf("inspect: %+v %v", inspected, err)
	}
	_, err = redeemDevice(f, d)
	requireDeviceError(t, err, "slow_down")
	f.now = f.now.Add(10 * time.Second)
	_, err = redeemDevice(f, d)
	requireDeviceError(t, err, "authorization_pending")
	if err = f.identity.DecideDevice(ctx, alice, d.UserCode, "approve", alice.UserID); err != nil {
		t.Fatal(err)
	}
	inspected, err = f.identity.InspectDevice(ctx, alice, d.UserCode)
	if err != nil || inspected.Status != "approved" {
		t.Fatalf("approved: %+v %v", inspected, err)
	}
	_, err = f.identity.InspectDevice(ctx, bob, d.UserCode)
	requireFault(t, err, "not_found")
	requireFault(t, f.identity.DecideDevice(ctx, bob, d.UserCode, "deny", bob.UserID), "not_found")
	requireFault(t, f.identity.DecideDevice(ctx, alice, d.UserCode, "deny", alice.UserID), "invalid_transition")
	f.now = f.now.Add(10 * time.Second)
	minted, err := redeemDevice(f, d)
	if err != nil {
		t.Fatal(err)
	}
	if !validSecret(minted.Secret, "dnpat_") || minted.Credential.Name != "Daynight CLI (workstation)" || minted.Credential.ExpiresAt != nil {
		t.Fatal("invalid CLI credential")
	}
	pat, err := f.identity.Authenticate(ctx, core.PATCredential, minted.Secret)
	if err != nil || pat.UserID != alice.UserID {
		t.Fatalf("CLI credential: %+v %v", pat, err)
	}
	listed, err := f.identity.ListPATs(ctx, alice)
	if err != nil || len(listed) != 1 || listed[0].Name != "Daynight CLI (workstation)" {
		t.Fatalf("account listing: %+v %v", listed, err)
	}
	inspected, err = f.identity.InspectDevice(ctx, alice, d.UserCode)
	if err != nil || inspected.Status != "consumed" {
		t.Fatalf("consumed: %+v %v", inspected, err)
	}
	_, err = redeemDevice(f, d)
	requireDeviceError(t, err, "invalid_grant")
	if err = f.identity.LogoutDevice(ctx, pat); err != nil {
		t.Fatal(err)
	}
	if err = f.identity.LogoutDevice(ctx, pat); err != nil {
		t.Fatal(err)
	}
	_, err = f.identity.Authenticate(ctx, core.PATCredential, minted.Secret)
	requireFault(t, err, "unauthenticated")
	requireFault(t, f.identity.LogoutDevice(ctx, alice), "forbidden")
}

func TestDeviceDeniedExpiredAndBrowserRestrictions(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	alice := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	denied := startDevice(t, f)
	if err := f.identity.DecideDevice(ctx, alice, denied.UserCode, "deny", alice.UserID); err != nil {
		t.Fatal(err)
	}
	_, err := redeemDevice(f, denied)
	requireDeviceError(t, err, "access_denied")
	inspected, err := f.identity.InspectDevice(ctx, alice, denied.UserCode)
	if err != nil || inspected.Status != "denied" {
		t.Fatalf("denied: %+v %v", inspected, err)
	}
	expired := startDevice(t, f)
	f.now = expired.ExpiresAt
	_, err = redeemDevice(f, expired)
	requireDeviceError(t, err, "expired_token")
	inspected, err = f.identity.InspectDevice(ctx, alice, expired.UserCode)
	if err != nil || inspected.Status != "expired" {
		t.Fatalf("expired: %+v %v", inspected, err)
	}
	requireFault(t, f.identity.DecideDevice(ctx, alice, expired.UserCode, "approve", alice.UserID), "invalid_transition")
	pat := core.Principal{Kind: core.PATCredential, UserID: alice.UserID, CredentialID: alice.CredentialID}
	_, err = f.identity.InspectDevice(ctx, pat, expired.UserCode)
	requireFault(t, err, "forbidden")
	requireFault(t, f.identity.DecideDevice(ctx, pat, expired.UserCode, "approve", pat.UserID), "forbidden")
	d := startDevice(t, f)
	requireFault(t, f.identity.DecideDevice(ctx, alice, d.UserCode, "other", alice.UserID), "invalid_input")
	for _, code := range []string{"", "ABC", "AAAAAAAAAA", "界界界界界"} {
		_, err = f.identity.InspectDevice(ctx, alice, code)
		requireFault(t, err, "invalid_input")
	}
	_, err = f.identity.InspectDevice(ctx, alice, "BBBBB-BBBBB")
	requireFault(t, err, "not_found")
	if err = f.identity.Logout(ctx, alice); err != nil {
		t.Fatal(err)
	}
	_, err = f.identity.InspectDevice(ctx, alice, d.UserCode)
	requireFault(t, err, "not_found")
}

func TestDeviceRequestValidationAndSecretNormalization(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	_, err := f.identity.StartDevice(ctx, "other", "source")
	requireDeviceError(t, err, "invalid_client")
	for _, input := range []struct{ client, grant, secret, want string }{
		{"other", DeviceGrantType, "x", "invalid_client"}, {DeviceClientID, "other", "x", "unsupported_grant_type"}, {DeviceClientID, DeviceGrantType, "!", "invalid_grant"}, {DeviceClientID, DeviceGrantType, randomSecret(""), "invalid_grant"},
	} {
		_, err = f.identity.RedeemDevice(ctx, input.client, input.grant, input.secret, "workstation")
		requireDeviceError(t, err, input.want)
	}
	code, err := normalizeDeviceCode(" bcdfg\t-hjklm ")
	if err != nil || code != "BCDFGHJKLM" {
		t.Fatalf("normalize: %s %v", code, err)
	}
}

func TestDeviceCredentialNames(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	alice := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	for _, input := range []struct{ hostname, display string }{
		{"workstation", "workstation"},
		{"开发工作站", "开发工作站"},
		{strings.Repeat("a", 85), strings.Repeat("a", 85)},
		{strings.Repeat("界", 84) + "🖥️", strings.Repeat("界", 84) + "🖥"},
		{strings.Repeat("界", 255), strings.Repeat("界", 85)},
	} {
		d := startDevice(t, f)
		if err := f.identity.DecideDevice(ctx, alice, d.UserCode, "approve", alice.UserID); err != nil {
			t.Fatal(err)
		}
		f.now = f.now.Add(5 * time.Second)
		minted, err := f.identity.RedeemDevice(ctx, DeviceClientID, DeviceGrantType, d.DeviceCode, input.hostname)
		if err != nil || minted.Credential.Name != "Daynight CLI ("+input.display+")" {
			t.Fatalf("hostname credential name: %q %v", minted.Credential.Name, err)
		}
		listed, err := f.identity.ListPATs(ctx, alice)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, credential := range listed {
			if credential.ID == minted.Credential.ID && credential.Name == minted.Credential.Name {
				found = true
			}
		}
		if !found {
			t.Fatalf("hostname name not persisted: %+v", listed)
		}
	}
}

func TestDeviceInvalidNameDoesNotConsumeGrant(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	alice := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	d := startDevice(t, f)
	if err := f.identity.DecideDevice(ctx, alice, d.UserCode, "approve", alice.UserID); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(5 * time.Second)
	for _, name := range []string{"", " \u2003", "\xff", "host\x00name", "host\nname", "host\u0085name", strings.Repeat("a", 256)} {
		minted, err := f.identity.RedeemDevice(ctx, DeviceClientID, DeviceGrantType, d.DeviceCode, name)
		requireDeviceError(t, err, "invalid_request")
		if minted.Secret != "" {
			t.Fatal("invalid name exposed a credential")
		}
	}
	listed, err := f.identity.ListPATs(ctx, alice)
	if err != nil || len(listed) != 0 {
		t.Fatalf("invalid name created credentials: %+v %v", listed, err)
	}
	inspected, err := f.identity.InspectDevice(ctx, alice, d.UserCode)
	if err != nil || inspected.Status != "approved" {
		t.Fatalf("invalid name consumed grant: %+v %v", inspected, err)
	}
	if _, err = redeemDevice(f, d); err != nil {
		t.Fatalf("valid name could not redeem rejected grant: %v", err)
	}
}

func TestDeviceConcurrentRedemptionAndDecision(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	alice := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	d := startDevice(t, f)
	launch := make(chan struct{})
	outcomes := make(chan error, 2)
	var workers sync.WaitGroup
	for _, decision := range []string{"approve", "deny"} {
		workers.Go(func() { <-launch; outcomes <- f.identity.DecideDevice(ctx, alice, d.UserCode, decision, alice.UserID) })
	}
	close(launch)
	workers.Wait()
	close(outcomes)
	successes := 0
	for err := range outcomes {
		if err == nil {
			successes++
		} else {
			requireFault(t, err, "invalid_transition")
		}
	}
	if successes != 1 {
		t.Fatalf("decision successes %d", successes)
	}
	d = startDevice(t, f)
	if err := f.identity.DecideDevice(ctx, alice, d.UserCode, "approve", alice.UserID); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(5 * time.Second)
	launch = make(chan struct{})
	outcomes = make(chan error, 8)
	for range 8 {
		workers.Go(func() { <-launch; _, err := redeemDevice(f, d); outcomes <- err })
	}
	close(launch)
	workers.Wait()
	close(outcomes)
	successes = 0
	for err := range outcomes {
		if err == nil {
			successes++
		} else {
			requireDeviceError(t, err, "invalid_grant")
		}
	}
	if successes != 1 {
		t.Fatalf("redemption successes %d", successes)
	}
	var tokens int
	if err := f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM personal_access_tokens`).Scan(&tokens); err != nil || tokens != 1 {
		t.Fatalf("concurrent credentials: %d %v", tokens, err)
	}
}

func TestDevicePersistentLimitsAndBoundedCleanup(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	alice := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	for range 30 {
		startDevice(t, f)
	}
	_, err := f.identity.StartDevice(ctx, DeviceClientID, "client-source")
	requireFault(t, err, "rate_limited")
	second := NewIdentity(f.database, nil, "")
	second.now = f.identity.now
	_, err = second.StartDevice(ctx, DeviceClientID, "client-source")
	requireFault(t, err, "rate_limited")
	for range 12 {
		_, err = f.identity.InspectDevice(ctx, alice, "BBBBB-BBBBB")
		requireFault(t, err, "not_found")
	}
	_, err = second.InspectDevice(ctx, alice, "BBBBB-BBBBB")
	requireFault(t, err, "rate_limited")
	if _, err = f.database.Pool.Exec(ctx, `INSERT INTO device_authorization_limits (bucket_hash,attempts,expires_at) SELECT decode(md5(i::text)||md5(i::text),'hex'),1,$1 FROM generate_series(1,200) i`, f.now.Add(-time.Minute)); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(time.Minute)
	if _, err = f.identity.StartDevice(ctx, DeviceClientID, "client-source"); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(DeviceLifetime + time.Hour)
	startDevice(t, f)
	var count int
	if err = f.database.Pool.QueryRow(ctx, `SELECT count(*) FROM device_authorizations`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("expired grants not cleaned: %d %v", count, err)
	}
	// Different sources share the same persistent service-wide creation budget.
	f.now = f.now.Add(time.Minute)
	for index := range 120 {
		_, err = f.identity.StartDevice(ctx, DeviceClientID, string(rune(index)))
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err = f.identity.StartDevice(ctx, DeviceClientID, "extra")
	requireFault(t, err, "rate_limited")
}

func TestDeviceStoreFailuresAndAtomicMint(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	alice := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	d := startDevice(t, f)
	if err := f.identity.DecideDevice(ctx, alice, d.UserCode, "approve", alice.UserID); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(5 * time.Second)
	if _, err := f.database.Pool.Exec(ctx, `ALTER TABLE personal_access_tokens ADD CONSTRAINT reject_cli CHECK (name <> 'Daynight CLI (workstation)')`); err != nil {
		t.Fatal(err)
	}
	result, err := redeemDevice(f, d)
	requireIdentityOperationalError(t, err)
	if result.Secret != "" {
		t.Fatal("failed commit exposed credential")
	}
	inspected, err := f.identity.InspectDevice(ctx, alice, d.UserCode)
	if err != nil || inspected.Status != "approved" {
		t.Fatalf("failed mint consumed grant: %+v %v", inspected, err)
	}
	if _, err = f.database.Pool.Exec(ctx, `ALTER TABLE personal_access_tokens DROP CONSTRAINT reject_cli`); err != nil {
		t.Fatal(err)
	}
	if _, err = redeemDevice(f, d); err != nil {
		t.Fatal(err)
	}
	f.database.Close()
	_, err = f.identity.StartDevice(ctx, DeviceClientID, "source")
	requireIdentityOperationalError(t, err)
	_, err = f.identity.InspectDevice(ctx, alice, d.UserCode)
	requireIdentityOperationalError(t, err)
	requireIdentityOperationalError(t, f.identity.DecideDevice(ctx, alice, d.UserCode, "approve", alice.UserID))
	_, err = redeemDevice(f, d)
	requireIdentityOperationalError(t, err)
	requireIdentityOperationalError(t, f.identity.LogoutDevice(ctx, core.Principal{Kind: core.PATCredential, UserID: alice.UserID, CredentialID: alice.CredentialID}))
}

func TestDeviceDecisionBindsReviewedAccount(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	alice := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	bob := identityPrincipal(t, f, completeIdentityLogin(t, f, "bob"))
	d := startDevice(t, f)
	if _, err := f.identity.InspectDevice(ctx, alice, d.UserCode); err != nil {
		t.Fatal(err)
	}
	requireFault(t, f.identity.DecideDevice(ctx, bob, d.UserCode, "approve", alice.UserID), "forbidden")
	requireFault(t, f.identity.DecideDevice(ctx, bob, d.UserCode, "deny", alice.UserID), "forbidden")
	requireFault(t, f.identity.DecideDevice(ctx, alice, d.UserCode, "approve", "bad"), "invalid_input")
	inspected, err := f.identity.InspectDevice(ctx, alice, d.UserCode)
	if err != nil || inspected.Status != "pending" {
		t.Fatalf("changed account mutated grant: %+v %v", inspected, err)
	}
	if err = f.identity.DecideDevice(ctx, alice, d.UserCode, "approve", alice.UserID); err != nil {
		t.Fatal(err)
	}
}

func TestDevicePersistenceFailuresRemainOperational(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	alice := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	d := startDevice(t, f)
	if _, err := f.database.Pool.Exec(ctx, `ALTER TABLE device_authorizations RENAME TO unavailable_device_authorizations`); err != nil {
		t.Fatal(err)
	}
	_, err := f.identity.InspectDevice(ctx, alice, d.UserCode)
	requireIdentityOperationalError(t, err)
	requireIdentityOperationalError(t, f.identity.DecideDevice(ctx, alice, d.UserCode, "approve", alice.UserID))
	_, err = redeemDevice(f, d)
	requireIdentityOperationalError(t, err)
	_, err = f.identity.StartDevice(ctx, DeviceClientID, "source")
	requireIdentityOperationalError(t, err)
	if _, err = f.database.Pool.Exec(ctx, `ALTER TABLE unavailable_device_authorizations RENAME TO device_authorizations`); err != nil {
		t.Fatal(err)
	}
	inspected, err := f.identity.InspectDevice(ctx, alice, d.UserCode)
	if err != nil || inspected.Status != "pending" {
		t.Fatal("failed persistence mutated grant")
	}
	if _, err = f.database.Pool.Exec(ctx, `ALTER TABLE device_authorization_limits RENAME TO unavailable_device_authorization_limits`); err != nil {
		t.Fatal(err)
	}
	_, err = f.identity.StartDevice(ctx, DeviceClientID, "source")
	requireIdentityOperationalError(t, err)
	f.database.Close()
	requireIdentityOperationalError(t, f.database.CreateDeviceAuthorization(ctx, core.DeviceAuthorization{}))
}
