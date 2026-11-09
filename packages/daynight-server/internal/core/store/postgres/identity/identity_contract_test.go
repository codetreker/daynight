package identity_test

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func TestIdentityDAOLoginSessionPATAndPersonalFacts(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user, principal, session := testutil.AuthRecords(t, s)
	login := model.LoginTransaction{ID: uuid.NewString(), StateHash: testutil.DeviceHash("state"), BrowserBindingHash: testutil.DeviceHash("browser"), ScopeHash: testutil.DeviceHash("scope"), Provider: "github", ReturnPath: "/projects", ExpiresAt: now.Add(time.Hour)}
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: testutil.DeviceHash("pat"), Name: "DAO PAT", CreatedAt: now}
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
		return nil
	})
	var logins, users, sessions int
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM login_transactions),(SELECT count(*) FROM users),(SELECT count(*) FROM sessions)`).Scan(&logins, &users, &sessions); err != nil || logins != 0 || users != 1 || sessions != 1 {
		t.Fatalf("consumption changed identity rows: logins=%d users=%d sessions=%d error=%v", logins, users, sessions, err)
	}
	completion, err := s.WriteIdentity(ctx, func(scope IdentityScope) error {
		_, err := scope.IdentityDAO().ConsumeLogin(ctx, login.StateHash, login.BrowserBindingHash, now)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) || completion.Outcome != TransactionNotCommitted {
		t.Fatalf("committed login replay: completion=%+v error=%v", completion, err)
	}
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM login_transactions),(SELECT count(*) FROM users),(SELECT count(*) FROM sessions)`).Scan(&logins, &users, &sessions); err != nil || logins != 0 || users != 1 || sessions != 1 {
		t.Fatalf("login replay changed identity rows: logins=%d users=%d sessions=%d error=%v", logins, users, sessions, err)
	}
	identityScopeTest(t, s, func(scope IdentityScope) error {
		dao := scope.IdentityDAO()
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
	email, name, avatar, verified := "shared@example.test", "Alice", "https://example.test/alice.png", true
	var bob model.User
	identityScopeTest(t, s, func(scope IdentityScope) error {
		dao := scope.IdentityDAO()
		updated, err := dao.UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: user.UniAuthID, Email: &email, EmailVerified: &verified, Name: &name, AvatarURL: &avatar}, now.Add(time.Minute))
		if err != nil {
			return err
		}
		if updated.ID != user.ID || updated.UniAuthID != user.UniAuthID || !updated.CreatedAt.Equal(user.CreatedAt) || !updated.UpdatedAt.Equal(now.Add(time.Minute)) || updated.Email == nil || *updated.Email != email || updated.Name == nil || *updated.Name != name || updated.AvatarURL == nil || *updated.AvatarURL != avatar || updated.EmailVerified == nil || !*updated.EmailVerified {
			t.Fatalf("same-provider profile lost identity or fields: %+v", updated)
		}
		bob, err = dao.UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: "github:" + uuid.NewString(), Email: &email, Name: &name}, now)
		if err == nil && bob.ID == user.ID {
			t.Fatal("same email merged distinct provider identities")
		}
		return err
	})
	updatedEmail, updatedName, updatedAvatar, updatedVerified := "refreshed@example.test", "Alice Updated", "https://example.test/alice-updated.png", false
	identityScopeTest(t, s, func(scope IdentityScope) error {
		_, err := scope.IdentityDAO().UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: user.UniAuthID, Email: &updatedEmail, EmailVerified: &updatedVerified, Name: &updatedName, AvatarURL: &updatedAvatar}, now.Add(2*time.Minute))
		return err
	})
	if actual, _, err := testutil.IdentityUser(ctx, s, user.ID); err != nil || actual.ID != user.ID || actual.UniAuthID != user.UniAuthID || !actual.CreatedAt.Equal(user.CreatedAt) || !actual.UpdatedAt.Equal(now.Add(2*time.Minute)) || actual.Email == nil || *actual.Email != updatedEmail || actual.EmailVerified == nil || *actual.EmailVerified || actual.Name == nil || *actual.Name != updatedName || actual.AvatarURL == nil || *actual.AvatarURL != updatedAvatar {
		t.Fatalf("updated false-verified profile was not persisted: %+v %v", actual, err)
	}
	identityScopeTest(t, s, func(scope IdentityScope) error {
		cleared, err := scope.IdentityDAO().UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: user.UniAuthID}, now.Add(3*time.Minute))
		if err != nil {
			return err
		}
		if cleared.ID != user.ID || !cleared.CreatedAt.Equal(user.CreatedAt) || cleared.Email != nil || cleared.EmailVerified != nil || cleared.Name != nil || cleared.AvatarURL != nil {
			t.Fatalf("profile clear changed identity or retained nullable fields: %+v", cleared)
		}
		return nil
	})
	if actual, _, err := testutil.IdentityUser(ctx, s, user.ID); err != nil || actual.ID != user.ID || actual.Email != nil || actual.EmailVerified != nil || actual.Name != nil || actual.AvatarURL != nil || !actual.UpdatedAt.Equal(now.Add(3*time.Minute)) {
		t.Fatalf("cleared profile was not persisted: %+v %v", actual, err)
	}
	if actual, _, err := testutil.IdentityUser(ctx, s, bob.ID); err != nil || !reflect.DeepEqual(actual, bob) {
		t.Fatalf("other account changed after profile update: %+v %v", actual, err)
	}
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
			_, err := sc.IdentityDAO().Authenticate(ctx, model.SessionCredential, testutil.DeviceHash("missing"), now)
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
	user, _, _ := testutil.AuthRecords(t, s)
	bucket := model.DeviceRateBucket{Hash: testutil.DeviceHash("rate"), Limit: 2}
	device := model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: testutil.DeviceHash("device"), UserCode: "BCDFGHJKLM", CreatedAt: now, ExpiresAt: now.Add(time.Hour), NextPollAt: now.Add(5 * time.Second), PollIntervalSeconds: 5}
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
			_, err := sc.IdentityDAO().LockDeviceByHash(ctx, testutil.DeviceHash("missing"))
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

func TestIdentityUserReturnsCanonicalPersonalReference(t *testing.T) {
	s := isolatedStore(t)
	user, principal, _ := testutil.AuthRecords(t, s)
	ctx := context.Background()
	got, facts, err := testutil.IdentityUser(ctx, s, principal.UserID)
	got.PersonalTeam.ID, got.PersonalTeam.Kind = facts.ID, "personal"
	if err != nil || !reflect.DeepEqual(got, user) || got.PersonalTeam.ID == "" || got.PersonalTeam.Kind != "personal" || got.PersonalTeam.Name != nil {
		t.Fatalf("account Personal reference differs from canonical login: %#v %#v %v", got, user, err)
	}
	if facts.MemberCount != 1 || facts.OwnerAdminCount != 1 {
		t.Fatalf("account member facts: %#v", facts)
	}
	var ownedTeam string
	if err := s.Pool.QueryRow(ctx, `SELECT t.id::text FROM teams t JOIN team_members m ON m.team_id=t.id
		WHERE t.personal_user_id=$1 AND m.user_id=$1 AND m.role='admin'`, user.ID).Scan(&ownedTeam); err != nil || ownedTeam != got.PersonalTeam.ID {
		t.Fatalf("account reference does not identify the stored Personal owner: %s %v", ownedTeam, err)
	}
	testutil.MustExec(t, s.Pool, `DELETE FROM teams WHERE id=$1`, ownedTeam)
	if _, facts, err := testutil.IdentityUser(ctx, s, user.ID); err != nil || facts.ID != "" || facts.MemberCount != 0 || facts.OwnerAdminCount != 0 {
		t.Fatalf("missing Personal Team facts: %#v %v", facts, err)
	}
}

func TestPersonalTeamFactsExposeCorruptMembershipSources(t *testing.T) {
	for _, damage := range []string{"missing-owner", "wrong-role", "additional-member"} {
		t.Run(damage, func(t *testing.T) {
			db := isolatedStore(t)
			user, _, _ := testutil.AuthRecords(t, db)
			ctx := t.Context()
			switch damage {
			case "missing-owner":
				testutil.MustExec(t, db.Pool, `DELETE FROM team_members WHERE user_id=$1`, user.ID)
			case "wrong-role":
				testutil.MustExec(t, db.Pool, `UPDATE team_members SET role='member' WHERE user_id=$1`, user.ID)
			case "additional-member":
				other, _, _ := testutil.AuthRecords(t, db)
				testutil.MustExec(t, db.Pool, `INSERT INTO team_members(team_id,user_id,role) SELECT id,$2,'member' FROM teams WHERE personal_user_id=$1`, user.ID, other.ID)
			}
			_, facts, err := testutil.IdentityUser(ctx, db, user.ID)
			if err != nil || facts.ID == "" {
				t.Fatalf("account team facts: %#v %v", facts, err)
			}
			if damage == "missing-owner" && (facts.MemberCount != 0 || facts.OwnerAdminCount != 0) || damage == "wrong-role" && (facts.MemberCount != 1 || facts.OwnerAdminCount != 0) || damage == "additional-member" && (facts.MemberCount != 2 || facts.OwnerAdminCount != 1) {
				t.Fatalf("account member facts for %s: %#v", damage, facts)
			}
		})
	}
}
