package store

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func identityScopeTest(t *testing.T, s *Store, op func(IdentityScope) error) {
	t.Helper()
	completion, err := s.WriteIdentity(context.Background(), op)
	if err != nil || completion.Outcome != TransactionCommitted {
		t.Fatalf("identity transaction: %#v %v", completion, err)
	}
}

func TestIdentityDAOLoginSessionPATAndPersonalFacts(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user, principal, session := testAuthRecords(t, s)
	login := model.LoginTransaction{ID: uuid.NewString(), StateHash: deviceStoreHash("state"), BrowserBindingHash: deviceStoreHash("browser"), Provider: "github", ReturnPath: "/projects", ExpiresAt: now.Add(time.Hour)}
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: deviceStoreHash("pat"), Name: "DAO PAT", CreatedAt: now}
	identityScopeTest(t, s, func(scope IdentityScope) error {
		dao := scope.IdentityDAO()
		if err := dao.CleanupCredentials(ctx, now); err != nil {
			return err
		}
		if err := dao.InsertLogin(ctx, login); err != nil {
			return err
		}
		if err := dao.LockSession(ctx, principal, now); err != nil {
			return err
		}
		if err := dao.InsertPAT(ctx, pat); err != nil {
			return err
		}
		facts, err := scope.PersonalTeamDAO().PersonalTeam(ctx, user.ID)
		if err != nil {
			return err
		}
		if facts.ID != user.PersonalTeam.ID || facts.MemberCount != 1 || facts.OwnerAdminCount != 1 {
			t.Fatalf("personal facts: %#v", facts)
		}
		created, err := scope.PersonalTeamDAO().InsertPersonalTeam(ctx, uuid.NewString(), user.ID, now)
		if err != nil || created {
			t.Fatalf("duplicate personal team: %t %v", created, err)
		}
		missing, err := scope.PersonalTeamDAO().PersonalTeam(ctx, uuid.NewString())
		if err != nil || missing != (PersonalTeamFacts{}) {
			t.Fatalf("missing facts: %#v %v", missing, err)
		}
		return nil
	})
	identityScopeTest(t, s, func(scope IdentityScope) error {
		dao := scope.IdentityDAO()
		got, err := dao.ConsumeLogin(ctx, login.StateHash, login.BrowserBindingHash, now)
		if err != nil || got.ID != login.ID || got.ReturnPath != login.ReturnPath {
			t.Fatalf("consumed login: %#v %v", got, err)
		}
		account, facts, err := dao.IdentityUser(ctx, user.ID)
		if err != nil || account.ID != user.ID || facts.ID != user.PersonalTeam.ID {
			t.Fatalf("account: %#v %#v %v", account, facts, err)
		}
		authenticated, err := dao.Authenticate(ctx, model.PATCredential, pat.TokenHash, now)
		if err != nil || authenticated.UserID != user.ID || authenticated.CredentialID != pat.ID {
			t.Fatalf("PAT authentication: %#v %v", authenticated, err)
		}
		tokens, err := dao.ListPATs(ctx, user.ID, now)
		if err != nil || len(tokens) != 1 || tokens[0].ID != pat.ID || tokens[0].TokenHash != nil {
			t.Fatalf("PAT list: %#v %v", tokens, err)
		}
		active, err := dao.LockActivePAT(ctx, user.ID, pat.ID, now)
		if err != nil || active.ID != pat.ID {
			t.Fatalf("PAT lock: %#v %v", active, err)
		}
		expiry := now.Add(time.Hour)
		updated, err := dao.SetPATExpiry(ctx, pat.ID, &expiry)
		if err != nil || updated.ExpiresAt == nil || !updated.ExpiresAt.Equal(expiry) {
			t.Fatalf("PAT expiry: %#v %v", updated, err)
		}
		return nil
	})
	for _, op := range []func(IdentityScope) error{
		func(sc IdentityScope) error {
			_, err := sc.IdentityDAO().ConsumeLogin(ctx, login.StateHash, login.BrowserBindingHash, now)
			return err
		},
		func(sc IdentityScope) error {
			return sc.IdentityDAO().LockSession(ctx, model.Principal{Kind: model.PATCredential}, now)
		},
		func(sc IdentityScope) error { return sc.IdentityDAO().LockSession(ctx, principal, session.ExpiresAt) },
		func(sc IdentityScope) error {
			_, err := sc.IdentityDAO().LockActivePAT(ctx, uuid.NewString(), pat.ID, now)
			return err
		},
		func(sc IdentityScope) error {
			_, _, err := sc.IdentityDAO().IdentityUser(ctx, uuid.NewString())
			return err
		},
		func(sc IdentityScope) error {
			_, err := sc.IdentityDAO().Authenticate(ctx, "other", pat.TokenHash, now)
			return err
		},
		func(sc IdentityScope) error {
			_, err := sc.IdentityDAO().Authenticate(ctx, model.SessionCredential, deviceStoreHash("missing"), now)
			return err
		},
	} {
		_, err := s.WriteIdentity(ctx, op)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("expected missing record: %v", err)
		}
	}
	identityScopeTest(t, s, func(sc IdentityScope) error {
		if err := sc.IdentityDAO().DeletePAT(ctx, user.ID, pat.ID); err != nil {
			return err
		}
		return sc.IdentityDAO().DeleteSession(ctx, principal)
	})
	identityScopeTest(t, s, func(sc IdentityScope) error {
		tokens, err := sc.IdentityDAO().ListPATs(ctx, user.ID, now)
		if err != nil || len(tokens) != 0 {
			t.Fatalf("deleted PAT list %#v %v", tokens, err)
		}
		return nil
	})
}

func TestIdentityDAODeviceOperations(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user, _, _ := testAuthRecords(t, s)
	bucket := model.DeviceRateBucket{Hash: deviceStoreHash("rate"), Limit: 2}
	device := model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: deviceStoreHash("device"), UserCode: "BCDFGHJKLM", CreatedAt: now, ExpiresAt: now.Add(time.Hour), NextPollAt: now.Add(5 * time.Second), PollIntervalSeconds: 5}
	identityScopeTest(t, s, func(sc IdentityScope) error {
		dao := sc.IdentityDAO()
		if err := dao.PruneDeviceRates(ctx, now); err != nil {
			return err
		}
		for want := 1; want <= 3; want++ {
			got, err := dao.IncrementDeviceRate(ctx, bucket, now)
			if err != nil || got != want {
				t.Fatalf("rate count %d want %d: %v", got, want, err)
			}
		}
		if err := dao.PruneDevices(ctx, now); err != nil {
			return err
		}
		return dao.InsertDevice(ctx, device)
	})
	identityScopeTest(t, s, func(sc IdentityScope) error {
		dao := sc.IdentityDAO()
		for _, lock := range []bool{false, true} {
			got, err := dao.DeviceByUserCode(ctx, user.ID, device.UserCode, lock)
			if err != nil || got.ID != device.ID || got.Status != "pending" {
				t.Fatalf("device by code: %#v %v", got, err)
			}
		}
		got, err := dao.LockDeviceByHash(ctx, device.DeviceCodeHash)
		if err != nil || got.ID != device.ID {
			t.Fatalf("device by hash: %#v %v", got, err)
		}
		if err = dao.DelayDevicePoll(ctx, device.ID, now, false); err != nil {
			return err
		}
		if err = dao.DelayDevicePoll(ctx, device.ID, now, true); err != nil {
			return err
		}
		if err = dao.SetDeviceDecision(ctx, device.ID, "approved", user.ID); err != nil {
			return err
		}
		got, err = dao.LockDeviceByHash(ctx, device.DeviceCodeHash)
		if err != nil || got.Status != "approved" || got.UserID == nil || *got.UserID != user.ID || got.PollIntervalSeconds != 10 || !got.NextPollAt.Equal(now.Add(10*time.Second)) {
			t.Fatalf("device updates: %#v %v", got, err)
		}
		return dao.ConsumeDevice(ctx, device.ID)
	})
	identityScopeTest(t, s, func(sc IdentityScope) error {
		got, err := sc.IdentityDAO().LockDeviceByHash(ctx, device.DeviceCodeHash)
		if err != nil || got.Status != "consumed" {
			t.Fatalf("consumed device: %#v %v", got, err)
		}
		n, err := sc.IdentityDAO().IncrementDeviceRate(ctx, bucket, now.Add(2*time.Minute))
		if err != nil || n != 1 {
			t.Fatalf("expired rate reset: %d %v", n, err)
		}
		return nil
	})
	for _, op := range []func(IdentityScope) error{
		func(sc IdentityScope) error {
			_, err := sc.IdentityDAO().DeviceByUserCode(ctx, uuid.NewString(), device.UserCode, false)
			return err
		},
		func(sc IdentityScope) error {
			_, err := sc.IdentityDAO().LockDeviceByHash(ctx, deviceStoreHash("missing"))
			return err
		},
	} {
		_, err := s.WriteIdentity(ctx, op)
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("expected missing device: %v", err)
		}
	}
	identityScopeTest(t, s, func(sc IdentityScope) error {
		if err := sc.IdentityDAO().PruneDeviceRates(ctx, now.Add(4*time.Minute)); err != nil {
			return err
		}
		return sc.IdentityDAO().PruneDevices(ctx, now.Add(3*time.Hour))
	})
	var devices, rates int
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM device_authorizations),(SELECT count(*) FROM device_authorization_limits)`).Scan(&devices, &rates); err != nil || devices != 0 || rates != 0 {
		t.Fatalf("pruning: %d %d %v", devices, rates, err)
	}
}

func TestIdentityDAOFailuresPreserveTransactionOutcome(t *testing.T) {
	for _, test := range []struct {
		name, table string
		operation   func(context.Context, IdentityScope, string) error
	}{
		{"PAT list", "personal_access_tokens", func(ctx context.Context, sc IdentityScope, id string) error {
			_, err := sc.IdentityDAO().ListPATs(ctx, id, time.Now())
			return err
		}},
		{"personal team lookup", "teams", func(ctx context.Context, sc IdentityScope, id string) error {
			_, err := sc.PersonalTeamDAO().PersonalTeam(ctx, id)
			return err
		}},
		{"device insert", "device_authorizations", func(ctx context.Context, sc IdentityScope, id string) error {
			return sc.IdentityDAO().InsertDevice(ctx, model.DeviceAuthorization{})
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := isolatedStore(t)
			ctx := context.Background()
			user, _, _ := testAuthRecords(t, s)
			if _, err := s.Pool.Exec(ctx, "DROP TABLE "+test.table+" CASCADE"); err != nil {
				t.Fatal(err)
			}
			completion, err := s.WriteIdentity(ctx, func(sc IdentityScope) error { return test.operation(ctx, sc, user.ID) })
			var databaseError *pgconn.PgError
			if err == nil || !errors.As(err, &databaseError) || databaseError.Code != "42P01" || completion.Outcome != TransactionNotCommitted {
				t.Fatalf("database failure or outcome lost: %#v %v", completion, err)
			}
		})
	}
	s := isolatedStore(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	completion, err := s.WriteIdentity(ctx, func(IdentityScope) error { t.Error("operation ran after cancellation"); return nil })
	if !errors.Is(err, context.Canceled) || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("canceled begin: %#v %v", completion, err)
	}
}

func TestIdentityCleanupFailureRollsBackEarlierDeletes(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	_, _, session := testAuthRecords(t, s)
	login := model.LoginTransaction{ID: uuid.NewString(), StateHash: deviceStoreHash("expired-state"), BrowserBindingHash: deviceStoreHash("expired-binding"), Provider: "github", ReturnPath: "/", ExpiresAt: now.Add(-time.Hour)}
	identityScopeTest(t, s, func(scope IdentityScope) error { return scope.IdentityDAO().InsertLogin(ctx, login) })
	if _, err := s.Pool.Exec(ctx, `UPDATE sessions SET created_at=$2,expires_at=$3 WHERE id=$1`, session.ID, now.Add(-2*time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `DROP TABLE personal_access_tokens`); err != nil {
		t.Fatal(err)
	}
	completion, err := s.WriteIdentity(ctx, func(scope IdentityScope) error { return scope.IdentityDAO().CleanupCredentials(ctx, now) })
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.Code != "42P01" || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("cleanup failure: %#v %v", completion, err)
	}
	var logins, sessions int
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM login_transactions WHERE id=$1),(SELECT count(*) FROM sessions WHERE id=$2)`, login.ID, session.ID).Scan(&logins, &sessions); err != nil || logins != 1 || sessions != 1 {
		t.Fatalf("cleanup committed partial deletes: %d %d %v", logins, sessions, err)
	}
}
