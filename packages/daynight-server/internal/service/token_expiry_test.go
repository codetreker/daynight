package service

import (
	"bytes"
	"context"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
)

func TestDeviceCredentialNeverExpiresAndSessionStillExpires(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	login := completeIdentityLogin(t, f, "alice")
	alice := identityPrincipal(t, f, login)
	d := startDevice(t, f)
	if err := f.identity.DecideDevice(ctx, alice, d.UserCode, "approve", alice.UserID); err != nil {
		t.Fatal(err)
	}
	f.now = f.now.Add(5 * time.Second)
	minted, err := redeemDevice(f, d)
	if err != nil {
		t.Fatal(err)
	}
	if minted.Credential.ExpiresAt != nil {
		t.Fatal("device credential has forced expiration")
	}
	f.now = f.now.Add(31 * 24 * time.Hour)
	pat, err := f.identity.Authenticate(ctx, core.PATCredential, minted.Secret)
	if err != nil {
		t.Fatalf("monthly login was forced: %v", err)
	}
	_, err = f.identity.Authenticate(ctx, core.SessionCredential, login.Secret)
	requireFault(t, err, "unauthenticated")
	renewedBrowser := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	if renewedBrowser.UserID != pat.UserID {
		t.Fatal("fresh browser lost credential owner")
	}
	tokens, err := f.identity.ListPATs(ctx, renewedBrowser)
	if err != nil || len(tokens) != 1 || tokens[0].ExpiresAt != nil {
		t.Fatal("nonexpiring credential was not manageable")
	}
	deadline := tokenExpiryAt(f.now.Add(time.Hour))
	changed, err := f.identity.UpdatePATExpiry(ctx, renewedBrowser, pat.CredentialID, UpdatePATExpiry{ExpiresAt: deadline, ExpectedUserID: pat.UserID})
	if err != nil || changed.ID != pat.CredentialID {
		t.Fatalf("issued credential could not be managed: %v", err)
	}
	if current, err := f.identity.Authenticate(ctx, core.PATCredential, minted.Secret); err != nil || current != pat {
		t.Fatal("expiry edit replaced current credential")
	}
	f.now = *deadline
	_, err = f.identity.Authenticate(ctx, core.PATCredential, minted.Secret)
	requireFault(t, err, "unauthenticated")
	_, err = f.identity.UpdatePATExpiry(ctx, renewedBrowser, pat.CredentialID, UpdatePATExpiry{ExpectedExpiresAt: deadline, ExpectedUserID: pat.UserID})
	requireFault(t, err, "not_found")
}

func TestTokenExpiryEditsValidateAccountObservationAndTarget(t *testing.T) {
	f := newIdentityFixture(t)
	ctx := context.Background()
	alice := identityPrincipal(t, f, completeIdentityLogin(t, f, "alice"))
	bob := identityPrincipal(t, f, completeIdentityLogin(t, f, "bob"))
	minted, err := f.identity.CreatePAT(ctx, alice, CreatePAT{Name: "Editable"})
	if err != nil {
		t.Fatal(err)
	}
	target := tokenExpiryAt(f.now.Add(time.Hour + 987*time.Nanosecond).In(time.FixedZone("UTC+08", 8*60*60)))
	changed, err := f.identity.UpdatePATExpiry(ctx, alice, minted.Credential.ID, UpdatePATExpiry{ExpiresAt: target, ExpectedUserID: alice.UserID})
	expected := target.UTC().Truncate(time.Microsecond)
	if err != nil || changed.ExpiresAt == nil || !changed.ExpiresAt.Equal(expected) || changed.ExpiresAt.Location() != time.UTC || changed.Name != minted.Credential.Name {
		t.Fatalf("expiry normalization: %v", err)
	}
	_, err = f.identity.UpdatePATExpiry(ctx, alice, minted.Credential.ID, UpdatePATExpiry{ExpectedUserID: alice.UserID})
	requireFault(t, err, "version_conflict")
	for _, input := range []UpdatePATExpiry{
		{ExpectedExpiresAt: changed.ExpiresAt, ExpectedUserID: "bad"},
		{ExpectedExpiresAt: changed.ExpiresAt, ExpectedUserID: strings.ToUpper("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa")},
		{ExpiresAt: tokenExpiryAt(f.now), ExpectedExpiresAt: changed.ExpiresAt, ExpectedUserID: alice.UserID},
		{ExpiresAt: tokenExpiryAt(f.now.Add(-time.Second)), ExpectedExpiresAt: changed.ExpiresAt, ExpectedUserID: alice.UserID},
	} {
		_, err = f.identity.UpdatePATExpiry(ctx, alice, minted.Credential.ID, input)
		requireFault(t, err, "invalid_input")
	}
	_, err = f.identity.UpdatePATExpiry(ctx, bob, minted.Credential.ID, UpdatePATExpiry{ExpectedExpiresAt: changed.ExpiresAt, ExpectedUserID: alice.UserID})
	requireFault(t, err, "forbidden")
	_, err = f.identity.UpdatePATExpiry(ctx, bob, minted.Credential.ID, UpdatePATExpiry{ExpectedExpiresAt: changed.ExpiresAt, ExpectedUserID: bob.UserID})
	requireFault(t, err, "not_found")
	_, err = f.identity.UpdatePATExpiry(ctx, alice, "invalid", UpdatePATExpiry{ExpectedUserID: alice.UserID})
	requireFault(t, err, "invalid_input")
	_, err = f.identity.UpdatePATExpiry(ctx, alice, uuid.NewString(), UpdatePATExpiry{ExpectedUserID: alice.UserID})
	requireFault(t, err, "not_found")
	pat, err := f.identity.Authenticate(ctx, core.PATCredential, minted.Secret)
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.identity.UpdatePATExpiry(ctx, pat, minted.Credential.ID, UpdatePATExpiry{ExpectedUserID: alice.UserID})
	requireFault(t, err, "forbidden")
	removed, err := f.identity.UpdatePATExpiry(ctx, alice, minted.Credential.ID, UpdatePATExpiry{ExpectedExpiresAt: changed.ExpiresAt, ExpectedUserID: alice.UserID})
	if err != nil || removed.ExpiresAt != nil {
		t.Fatalf("remove expiration: %v", err)
	}
	var hash []byte
	if err = f.database.Pool.QueryRow(ctx, `SELECT token_hash FROM personal_access_tokens WHERE id=$1`, minted.Credential.ID).Scan(&hash); err != nil || !bytes.Equal(hash, minted.Credential.TokenHash) {
		t.Fatal("expiry edit changed original secret")
	}
	if err = f.identity.RevokePAT(ctx, alice, minted.Credential.ID); err != nil {
		t.Fatal(err)
	}
	_, err = f.identity.UpdatePATExpiry(ctx, alice, minted.Credential.ID, UpdatePATExpiry{ExpectedUserID: alice.UserID})
	requireFault(t, err, "not_found")
	f.database.Close()
	_, err = f.identity.UpdatePATExpiry(ctx, alice, minted.Credential.ID, UpdatePATExpiry{ExpectedUserID: alice.UserID})
	requireIdentityOperationalError(t, err)
}
