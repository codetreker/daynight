package identity

import (
	"context"
	"crypto/sha256"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	"github.com/google/uuid"
)

func isolatedStore(t *testing.T) *postgres.Store {
	t.Helper()
	s, err := postgres.Open(context.Background(), serviceDatabaseURL(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}
func testIdentityWrite(s *postgres.Store, ctx context.Context, f func(store.IdentityScope) error) error {
	_, err := s.WriteIdentity(ctx, f)
	return err
}
func testAuthRecords(t *testing.T, s *postgres.Store) (model.User, model.Principal, model.Session) {
	t.Helper()
	ctx := context.Background()
	now := time.Now().UTC()
	h := sha256.Sum256([]byte(uuid.NewString()))
	c := model.Session{ID: uuid.NewString(), TokenHash: h[:], CreatedAt: now, ExpiresAt: now.Add(time.Hour)}
	var u model.User
	var p model.Principal
	module := core.NewIdentity("")
	err := testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		var err error
		u, err = module.CompleteLogin(ctx, sc.IdentityDAO(), model.User{UniAuthID: "github:" + uuid.NewString()}, now)
		if err != nil {
			return err
		}
		u.PersonalTeam, err = team.BootstrapPersonalTeam(ctx, sc.PersonalTeamDAO(), u.ID, now)
		if err != nil {
			return err
		}
		c.UserID = u.ID
		return module.CreateSession(ctx, sc.IdentityDAO(), c)
	})
	if err != nil {
		t.Fatal(err)
	}
	err = testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		var err error
		p, err = sc.IdentityDAO().Authenticate(ctx, model.SessionCredential, h[:], now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return u, p, c
}
func testAuthenticate(s *postgres.Store, ctx context.Context, k model.CredentialKind, h []byte, now time.Time) (model.Principal, error) {
	var p model.Principal
	err := testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		var err error
		p, err = sc.IdentityDAO().Authenticate(ctx, k, h, now)
		return err
	})
	return p, err
}
func testDeleteSession(s *postgres.Store, ctx context.Context, p model.Principal) error {
	return testIdentityWrite(s, ctx, func(sc store.IdentityScope) error { return sc.IdentityDAO().DeleteSession(ctx, p) })
}
func testCreatePAT(s *postgres.Store, ctx context.Context, p model.Principal, c model.PersonalAccessToken) error {
	return testIdentityWrite(s, ctx, func(sc store.IdentityScope) error { return core.NewIdentity("").StorePAT(ctx, sc.IdentityDAO(), p, c) })
}
func testListPATs(s *postgres.Store, ctx context.Context, p model.Principal, now time.Time) ([]model.PersonalAccessToken, error) {
	var result []model.PersonalAccessToken
	err := testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		var err error
		result, err = core.NewIdentity("").ListPATs(ctx, sc.IdentityDAO(), p, now)
		return err
	})
	return result, err
}
func testTakeDeviceRate(s *postgres.Store, ctx context.Context, b []model.DeviceRateBucket, now time.Time) (bool, error) {
	var allowed bool
	err := testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		var err error
		allowed, err = core.NewIdentity("").TakeDeviceRate(ctx, sc.IdentityDAO(), b, now)
		return err
	})
	return allowed, err
}
func testCreateDeviceAuthorization(s *postgres.Store, ctx context.Context, d model.DeviceAuthorization) error {
	return testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		dao := sc.IdentityDAO()
		if err := dao.PruneDevices(ctx, d.CreatedAt); err != nil {
			return err
		}
		return dao.InsertDevice(ctx, d)
	})
}
func testInspectDeviceAuthorization(s *postgres.Store, ctx context.Context, p model.Principal, code string, now time.Time) (model.DeviceAuthorization, error) {
	var d model.DeviceAuthorization
	err := testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		dao := sc.IdentityDAO()
		if err := dao.LockSession(ctx, p, now); err != nil {
			return err
		}
		var err error
		d, err = dao.DeviceByUserCode(ctx, p.UserID, code, false)
		return err
	})
	return d, err
}
func testDecideDeviceAuthorization(s *postgres.Store, ctx context.Context, p model.Principal, code, status string, now time.Time) (string, error) {
	var outcome string
	err := testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		var err error
		outcome, err = core.NewIdentity("").DecideGrant(ctx, sc.IdentityDAO(), p, code, status, now)
		return err
	})
	return outcome, err
}
func testRedeemDeviceAuthorization(s *postgres.Store, ctx context.Context, h []byte, c model.PersonalAccessToken) (string, error) {
	var outcome string
	err := testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		var err error
		outcome, err = core.NewIdentity("").RedeemGrant(ctx, sc.IdentityDAO(), h, c)
		return err
	})
	return outcome, err
}
func testDeleteCurrentPAT(s *postgres.Store, ctx context.Context, p model.Principal) error {
	return testIdentityWrite(s, ctx, func(sc store.IdentityScope) error { return sc.IdentityDAO().DeletePAT(ctx, p.UserID, p.CredentialID) })
}
func testUpdatePATExpiry(s *postgres.Store, ctx context.Context, p model.Principal, id string, expiry, expected *time.Time, now time.Time) (model.PersonalAccessToken, bool, error) {
	var result model.PersonalAccessToken
	var conflict bool
	err := testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		var err error
		result, conflict, err = core.NewIdentity("").ComparePATExpiry(ctx, sc.IdentityDAO(), p, id, expiry, expected, now)
		return err
	})
	return result, conflict, err
}
func storeTokenExpiry(value time.Time) *time.Time { return &value }

func testCreateLogin(s *postgres.Store, ctx context.Context, p model.LoginTransaction, now time.Time) error {
	return testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		_, err := core.NewIdentity("").CreateLogin(ctx, sc.IdentityDAO(), p, now)
		return err
	})
}
func testConsumeLogin(s *postgres.Store, ctx context.Context, h, b []byte, now time.Time) (model.LoginTransaction, error) {
	var p model.LoginTransaction
	err := testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		var err error
		p, err = sc.IdentityDAO().ConsumeLogin(ctx, h, b, now)
		return err
	})
	return p, err
}
func testCreateIdentitySession(s *postgres.Store, ctx context.Context, u model.User, c model.Session) (model.User, error) {
	var result model.User
	module := core.NewIdentity("")
	err := testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		var err error
		result, err = module.CompleteLogin(ctx, sc.IdentityDAO(), u, c.CreatedAt)
		if err != nil {
			return err
		}
		result.PersonalTeam, err = team.BootstrapPersonalTeam(ctx, sc.PersonalTeamDAO(), result.ID, c.CreatedAt)
		if err != nil {
			return err
		}
		c.UserID = result.ID
		return module.CreateSession(ctx, sc.IdentityDAO(), c)
	})
	return result, err
}
func testIdentityUser(s *postgres.Store, ctx context.Context, id string) (model.User, error) {
	return New(s, nil, "").User(ctx, model.Principal{UserID: id})
}
func testRevokePAT(s *postgres.Store, ctx context.Context, p model.Principal, id string, now time.Time) error {
	return testIdentityWrite(s, ctx, func(sc store.IdentityScope) error {
		return core.NewIdentity("").RevokePAT(ctx, sc.IdentityDAO(), p, id, now)
	})
}
