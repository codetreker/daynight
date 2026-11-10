package identity_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func identityTransaction(t *testing.T) (pgx.Tx, store.IdentityScope) {
	t.Helper()
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	tx, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	return tx, identity.NewScope(tx)
}

func hash(value string) []byte { sum := sha256.Sum256([]byte(value)); return sum[:] }
func requireNoError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
func requireMissing(t *testing.T, err error) {
	t.Helper()
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("expected absence, got %v", err)
	}
	if failed, _ := store.DatabaseErrorFacts(err); failed {
		t.Fatalf("absence classified as database failure: %v", err)
	}
}

func TestCredentialIssuanceExpiryAndOwnerBoundRevocation(t *testing.T) {
	tx, sc := identityTransaction(t)
	ctx, dao := t.Context(), sc.IdentityDAO()
	now := time.Now().UTC().Truncate(time.Microsecond)
	name := "Original"
	user, err := dao.UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: "provider-account", Name: &name}, now)
	requireNoError(t, err)
	changedName := "Updated"
	updated, err := dao.UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: user.UniAuthID, Name: &changedName}, now.Add(time.Minute))
	requireNoError(t, err)
	if updated.ID != user.ID || !updated.CreatedAt.Equal(now) || !updated.UpdatedAt.Equal(now.Add(time.Minute)) || updated.Name == nil || *updated.Name != changedName {
		t.Fatalf("upsert lost account identity: %+v", updated)
	}

	login := model.LoginTransaction{ID: uuid.NewString(), StateHash: hash("state"), BrowserBindingHash: hash("binding"), ScopeHash: hash("scope"), Provider: "github", ReturnPath: "/projects", ExpiresAt: now.Add(time.Hour)}
	requireNoError(t, dao.InsertLogin(ctx, login))
	_, err = dao.ConsumeLogin(ctx, login.StateHash, hash("other-browser"), now)
	requireMissing(t, err)
	consumed, err := dao.ConsumeLogin(ctx, login.StateHash, login.BrowserBindingHash, now)
	requireNoError(t, err)
	if consumed.ID != login.ID || consumed.Provider != login.Provider || consumed.ReturnPath != login.ReturnPath || !consumed.ExpiresAt.Equal(login.ExpiresAt) {
		t.Fatalf("login round trip: %+v", consumed)
	}
	_, err = dao.ConsumeLogin(ctx, login.StateHash, login.BrowserBindingHash, now)
	requireMissing(t, err)
	expiredLogin := login
	expiredLogin.ID, expiredLogin.StateHash, expiredLogin.ExpiresAt = uuid.NewString(), hash("expired-state"), now
	requireNoError(t, dao.InsertLogin(ctx, expiredLogin))
	_, err = dao.ConsumeLogin(ctx, expiredLogin.StateHash, expiredLogin.BrowserBindingHash, now)
	requireMissing(t, err)

	session := model.Session{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("session"), CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	requireNoError(t, dao.InsertSession(ctx, session))
	principal, err := dao.Authenticate(ctx, model.SessionCredential, session.TokenHash, now)
	requireNoError(t, err)
	if principal != (model.Principal{Kind: model.SessionCredential, CredentialID: session.ID, UserID: user.ID}) {
		t.Fatalf("session principal: %+v", principal)
	}
	requireNoError(t, dao.LockSession(ctx, principal, now))
	requireMissing(t, dao.LockSession(ctx, principal, session.ExpiresAt))
	requireMissing(t, dao.LockSession(ctx, model.Principal{Kind: model.PATCredential}, now))
	requireNoError(t, dao.DeleteSession(ctx, model.Principal{CredentialID: session.ID, UserID: uuid.NewString()}))
	_, err = dao.Authenticate(ctx, model.SessionCredential, session.TokenHash, now)
	requireNoError(t, err)
	requireNoError(t, dao.DeleteSession(ctx, principal))
	_, err = dao.Authenticate(ctx, model.SessionCredential, session.TokenHash, now)
	requireMissing(t, err)
	_, err = dao.Authenticate(ctx, model.OAuthCredential, hash("unknown-kind"), now)
	requireMissing(t, err)

	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("pat"), Name: "Automation", CreatedAt: now}
	requireNoError(t, dao.InsertPAT(ctx, pat))
	patPrincipal, err := dao.Authenticate(ctx, model.PATCredential, pat.TokenHash, now.Add(365*24*time.Hour))
	requireNoError(t, err)
	if patPrincipal.CredentialID != pat.ID || patPrincipal.UserID != user.ID {
		t.Fatalf("PAT principal: %+v", patPrincipal)
	}
	expiry := now.Add(time.Hour)
	result, err := dao.SetPATExpiry(ctx, pat.ID, &expiry)
	requireNoError(t, err)
	if result.ExpiresAt == nil || !result.ExpiresAt.Equal(expiry) || result.TokenHash != nil || result.CreatedAt.Location() != time.UTC || result.ExpiresAt.Location() != time.UTC {
		t.Fatalf("PAT expiry projection: %+v", result)
	}
	_, err = dao.LockActivePAT(ctx, uuid.NewString(), pat.ID, now)
	requireMissing(t, err)
	_, err = dao.LockActivePAT(ctx, user.ID, pat.ID, expiry)
	requireMissing(t, err)
	tokens, err := dao.ListPATs(ctx, user.ID, expiry)
	requireNoError(t, err)
	if len(tokens) != 0 {
		t.Fatalf("expired token listed: %+v", tokens)
	}
	result, err = dao.SetPATExpiry(ctx, pat.ID, nil)
	requireNoError(t, err)
	if result.ExpiresAt != nil {
		t.Fatalf("expiry was not removed: %+v", result)
	}
	active, err := dao.LockActivePAT(ctx, user.ID, pat.ID, expiry)
	requireNoError(t, err)
	if active.ID != pat.ID || active.Name != pat.Name {
		t.Fatalf("active PAT: %+v", active)
	}
	tokens, err = dao.ListPATs(ctx, user.ID, expiry)
	requireNoError(t, err)
	if len(tokens) != 1 || tokens[0].ID != pat.ID || tokens[0].TokenHash != nil {
		t.Fatalf("PAT projection: %+v", tokens)
	}
	requireNoError(t, dao.DeletePAT(ctx, uuid.NewString(), pat.ID))
	_, err = dao.Authenticate(ctx, model.PATCredential, pat.TokenHash, now)
	requireNoError(t, err)
	requireNoError(t, dao.DeletePAT(ctx, user.ID, pat.ID))
	_, err = dao.Authenticate(ctx, model.PATCredential, pat.TokenHash, now)
	requireMissing(t, err)

	requireNoError(t, dao.CleanupCredentials(ctx, now))
	var remaining int
	requireNoError(t, tx.QueryRow(ctx, `SELECT count(*) FROM login_transactions`).Scan(&remaining))
	if remaining != 0 {
		t.Fatalf("expired login retained: %d", remaining)
	}
}

func TestPersonalTeamFactsAndUniqueness(t *testing.T) {
	_, sc := identityTransaction(t)
	ctx, dao, teams := t.Context(), sc.IdentityDAO(), sc.PersonalTeamDAO()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user, err := dao.UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: "personal-owner"}, now)
	requireNoError(t, err)
	empty, err := teams.PersonalTeam(ctx, user.ID)
	requireNoError(t, err)
	if empty != (store.PersonalTeamFacts{}) {
		t.Fatalf("unexpected personal team: %+v", empty)
	}
	empty, err = dao.IdentityPersonalTeam(ctx, user.ID)
	requireNoError(t, err)
	if empty != (store.PersonalTeamFacts{}) {
		t.Fatalf("unexpected identity team: %+v", empty)
	}
	id := uuid.NewString()
	created, err := teams.InsertPersonalTeam(ctx, id, user.ID, now)
	requireNoError(t, err)
	if !created {
		t.Fatal("personal team not created")
	}
	created, err = teams.InsertPersonalTeam(ctx, uuid.NewString(), user.ID, now)
	requireNoError(t, err)
	if created {
		t.Fatal("duplicate personal team created")
	}
	requireNoError(t, teams.InsertPersonalOwner(ctx, id, user.ID, now))
	expected := store.PersonalTeamFacts{ID: id, MemberCount: 1, OwnerAdminCount: 1}
	facts, err := teams.PersonalTeam(ctx, user.ID)
	requireNoError(t, err)
	if facts != expected {
		t.Fatalf("personal team facts: %+v", facts)
	}
	facts, err = dao.IdentityPersonalTeam(ctx, user.ID)
	requireNoError(t, err)
	if facts != expected {
		t.Fatalf("identity facts: %+v", facts)
	}
	account, facts, err := dao.IdentityUser(ctx, user.ID)
	requireNoError(t, err)
	if account.ID != user.ID || facts != expected {
		t.Fatalf("account=%+v facts=%+v", account, facts)
	}
	_, _, err = dao.IdentityUser(ctx, uuid.NewString())
	requireMissing(t, err)
	_, err = dao.IdentityPersonalTeam(ctx, uuid.NewString())
	requireMissing(t, err)
}

func TestDeviceOwnershipPollingAndPruning(t *testing.T) {
	tx, sc := identityTransaction(t)
	ctx, dao := t.Context(), sc.IdentityDAO()
	now := time.Now().UTC().Truncate(time.Microsecond)
	bucket := model.DeviceRateBucket{Hash: hash("rate"), Limit: 2}
	for _, want := range []int{1, 2, 3, 3} {
		got, err := dao.IncrementDeviceRate(ctx, bucket, now)
		requireNoError(t, err)
		if got != want {
			t.Fatalf("rate=%d want %d", got, want)
		}
	}
	got, err := dao.IncrementDeviceRate(ctx, bucket, now.Add(time.Minute))
	requireNoError(t, err)
	if got != 1 {
		t.Fatalf("expired bucket not reset: %d", got)
	}
	d := model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: hash("device"), UserCode: "BCDFGHJKLM", CreatedAt: now, ExpiresAt: now.Add(time.Hour), NextPollAt: now.Add(5 * time.Second), PollIntervalSeconds: 5}
	requireNoError(t, dao.InsertDevice(ctx, d))
	owner := uuid.NewString()
	pending, err := dao.DeviceByUserCode(ctx, owner, d.UserCode, false)
	requireNoError(t, err)
	if pending.Status != "pending" || pending.UserID != nil {
		t.Fatalf("pending device: %+v", pending)
	}
	requireNoError(t, dao.DelayDevicePoll(ctx, d.ID, now, false))
	polled, err := dao.LockDeviceByHash(ctx, d.DeviceCodeHash)
	requireNoError(t, err)
	if !polled.NextPollAt.Equal(now.Add(5*time.Second)) || polled.PollIntervalSeconds != 5 {
		t.Fatalf("normal polling: %+v", polled)
	}
	requireNoError(t, dao.DelayDevicePoll(ctx, d.ID, now, true))
	requireNoError(t, dao.SetDeviceDecision(ctx, d.ID, "approved", owner))
	approved, err := dao.DeviceByUserCode(ctx, owner, d.UserCode, true)
	requireNoError(t, err)
	if approved.ID != d.ID || approved.Status != "approved" || approved.UserID == nil || *approved.UserID != owner || approved.PollIntervalSeconds != 10 || !approved.NextPollAt.Equal(now.Add(10*time.Second)) {
		t.Fatalf("approved device: %+v", approved)
	}
	_, err = dao.DeviceByUserCode(ctx, uuid.NewString(), d.UserCode, false)
	requireMissing(t, err)
	_, err = dao.LockDeviceByHash(ctx, hash("missing-device"))
	requireMissing(t, err)
	requireNoError(t, dao.ConsumeDevice(ctx, d.ID))
	consumed, err := dao.LockDeviceByHash(ctx, d.DeviceCodeHash)
	requireNoError(t, err)
	if consumed.Status != "consumed" {
		t.Fatalf("device not consumed: %+v", consumed)
	}
	requireNoError(t, dao.PruneDevices(ctx, d.ExpiresAt.Add(time.Hour-time.Microsecond)))
	_, err = dao.LockDeviceByHash(ctx, d.DeviceCodeHash)
	requireNoError(t, err)
	requireNoError(t, dao.PruneDevices(ctx, d.ExpiresAt.Add(time.Hour)))
	_, err = dao.LockDeviceByHash(ctx, d.DeviceCodeHash)
	requireMissing(t, err)
	requireNoError(t, dao.PruneDeviceRates(ctx, now.Add(2*time.Minute)))
	var rates int
	requireNoError(t, tx.QueryRow(ctx, `SELECT count(*) FROM device_authorization_limits`).Scan(&rates))
	if rates != 0 {
		t.Fatalf("expired rate bucket retained: %d", rates)
	}
}

func TestCredentialCleanupRetainsActiveAndPermanentTokens(t *testing.T) {
	tx, sc := identityTransaction(t)
	ctx, dao := t.Context(), sc.IdentityDAO()
	var now time.Time
	requireNoError(t, tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&now))
	user, err := dao.UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: "cleanup-owner"}, now)
	requireNoError(t, err)
	expired := now
	old := now.Add(-time.Hour)
	requireNoError(t, dao.InsertLogin(ctx, model.LoginTransaction{ID: uuid.NewString(), StateHash: hash("cleanup-login"), BrowserBindingHash: hash("cleanup-binding"), ScopeHash: hash("scope"), Provider: "github", ReturnPath: "/", ExpiresAt: now}))
	requireNoError(t, dao.InsertSession(ctx, model.Session{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("cleanup-session"), CreatedAt: old, ExpiresAt: now}))
	requireNoError(t, dao.InsertPAT(ctx, model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("expired-pat"), Name: "Expired", CreatedAt: old, ExpiresAt: &expired}))
	first := model.PersonalAccessToken{ID: "00000000-0000-0000-0000-000000000001", UserID: user.ID, TokenHash: hash("first-pat"), Name: "Permanent", CreatedAt: now}
	second := first
	second.ID, second.TokenHash, second.Name = "00000000-0000-0000-0000-000000000002", hash("second-pat"), "Expiring"
	future := now.Add(time.Hour)
	second.ExpiresAt = &future
	requireNoError(t, dao.InsertPAT(ctx, second))
	requireNoError(t, dao.InsertPAT(ctx, first))
	requireNoError(t, dao.CleanupCredentials(ctx, now))
	var logins, sessions, pats int
	requireNoError(t, tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM login_transactions),(SELECT count(*) FROM sessions),(SELECT count(*) FROM personal_access_tokens)`).Scan(&logins, &sessions, &pats))
	if logins != 0 || sessions != 0 || pats != 2 {
		t.Fatalf("cleanup rows: logins=%d sessions=%d pats=%d", logins, sessions, pats)
	}
	_, err = tx.Exec(ctx, `SET LOCAL TIME ZONE 'America/New_York'`)
	requireNoError(t, err)
	tokens, err := dao.ListPATs(ctx, user.ID, now)
	requireNoError(t, err)
	if len(tokens) != 2 || tokens[0].ID != first.ID || tokens[1].ID != second.ID {
		t.Fatalf("token creation/ID order: %+v", tokens)
	}
	if tokens[0].CreatedAt.Location() != time.UTC || tokens[1].ExpiresAt == nil || tokens[1].ExpiresAt.Location() != time.UTC || !tokens[1].ExpiresAt.Equal(future) {
		t.Fatalf("non-UTC database session leaked into token projection: %+v", tokens)
	}
	other, err := dao.ListPATs(ctx, uuid.NewString(), now)
	requireNoError(t, err)
	if len(other) != 0 {
		t.Fatalf("another owner's tokens exposed: %+v", other)
	}
}

func TestLoginExpiryUsesDatabaseTimeAcrossApplicationClockSkew(t *testing.T) {
	for _, test := range []struct {
		name             string
		delta            time.Duration
		admissionCleanup bool
	}{
		{"admission service behind", -24 * time.Hour, true},
		{"admission service ahead", 24 * time.Hour, true},
		{"PAT service behind", -24 * time.Hour, false},
		{"PAT service ahead", 24 * time.Hour, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			tx, scope := identityTransaction(t)
			ctx, dao := t.Context(), scope.IdentityDAO()
			var databaseNow time.Time
			requireNoError(t, tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&databaseNow))
			appNow := databaseNow.Add(test.delta)
			active := model.LoginTransaction{ID: uuid.NewString(), StateHash: hash("active-state"), BrowserBindingHash: hash("binding"), ScopeHash: hash("scope"), Provider: "github", ReturnPath: "/", ExpiresAt: databaseNow.Add(10 * time.Minute)}
			expired := active
			expired.ID, expired.StateHash, expired.ExpiresAt = uuid.NewString(), hash("expired-state"), databaseNow.Add(-time.Minute)
			requireNoError(t, dao.InsertLogin(ctx, active))
			requireNoError(t, dao.InsertLogin(ctx, expired))
			_, err := dao.ConsumeLogin(ctx, expired.StateHash, expired.BrowserBindingHash, databaseNow.Add(-24*time.Hour))
			requireMissing(t, err)

			user, err := dao.UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: "skew-owner"}, appNow)
			requireNoError(t, err)
			expiry := appNow.Add(time.Hour)
			requireNoError(t, dao.InsertSession(ctx, model.Session{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("skew-session"), CreatedAt: appNow, ExpiresAt: expiry}))
			requireNoError(t, dao.InsertPAT(ctx, model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("skew-pat"), Name: "Skew", CreatedAt: appNow, ExpiresAt: &expiry}))
			if test.admissionCleanup {
				requireNoError(t, dao.CleanupLoginCredentials(ctx, databaseNow, appNow))
			} else {
				requireNoError(t, dao.CleanupCredentials(ctx, appNow))
			}
			var logins, sessions, pats int
			requireNoError(t, tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM login_transactions),(SELECT count(*) FROM sessions),(SELECT count(*) FROM personal_access_tokens)`).Scan(&logins, &sessions, &pats))
			if logins != 1 || sessions != 1 || pats != 1 {
				t.Fatalf("cleanup mixed clock domains: logins=%d sessions=%d pats=%d", logins, sessions, pats)
			}
			consumed, err := dao.ConsumeLogin(ctx, active.StateHash, active.BrowserBindingHash, databaseNow.Add(24*time.Hour))
			requireNoError(t, err)
			if consumed.ID != active.ID {
				t.Fatalf("wrong login consumed: %+v", consumed)
			}
			_, err = dao.ConsumeLogin(ctx, active.StateHash, active.BrowserBindingHash, databaseNow.Add(-24*time.Hour))
			requireMissing(t, err)
		})
	}
}
