package identity_test

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	serviceidentity "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestScopedDeviceDecisionAndRedemptionPersistence(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, session, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	code := secret.Random("")
	device := model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: secret.Hash(code), UserCode: "BCDFGHJKLM", CreatedAt: now, ExpiresAt: now.Add(time.Minute), NextPollAt: now, PollIntervalSeconds: 5}
	identityScopeTest(t, db, func(s store.IdentityScope) error { return s.IdentityDAO().InsertDevice(ctx, device) })
	module := core.NewIdentity("")
	selected := []scopepolicy.ScopeID{"project:read", "task:read"}
	identityScopeTest(t, db, func(s store.IdentityScope) error {
		dao := s.IdentityDAO()
		return module.DecideDeviceScoped(ctx, dao, dao.(store.DeviceScopeDAO), session, device.UserCode, "approve", user.ID, selected, now)
	})
	identityScopeTest(t, db, func(s store.IdentityScope) error {
		d, err := s.IdentityDAO().DeviceByUserCode(ctx, user.ID, device.UserCode, false)
		if err != nil {
			return err
		}
		if d.Status != "approved" || d.UserID == nil || *d.UserID != user.ID || !slices.Equal(d.ApprovedScopes, selected) {
			t.Fatalf("decision readback: %+v", d)
		}
		return nil
	})
	var minted core.MintedPAT
	identityScopeTest(t, db, func(s store.IdentityScope) error {
		dao := s.IdentityDAO()
		var err error
		minted, err = module.RedeemDeviceScoped(ctx, dao, dao.(store.DeviceScopeDAO), core.DeviceClientID, core.DeviceGrantType, code, "machine", now)
		return err
	})
	identityScopeTest(t, db, func(s store.IdentityScope) error {
		dao := s.IdentityDAO()
		pat, err := dao.(store.PATScopeDAO).PATByHash(ctx, secret.Hash(minted.Secret), now)
		if err != nil {
			return err
		}
		if pat.ID != minted.Credential.ID || pat.UserID != user.ID || pat.ScopePolicy.Version() != 1 || !slices.Equal(pat.ScopePolicy.Scopes(), selected) {
			t.Fatalf("persisted PAT: %+v", pat)
		}
		d, err := dao.LockDeviceByHash(ctx, device.DeviceCodeHash)
		if err != nil {
			return err
		}
		if d.Status != "consumed" {
			t.Fatalf("device status=%s", d.Status)
		}
		return nil
	})
	_, err := db.WriteIdentity(ctx, func(s store.IdentityScope) error {
		dao := s.IdentityDAO()
		_, err := module.RedeemDeviceScoped(ctx, dao, dao.(store.DeviceScopeDAO), core.DeviceClientID, core.DeviceGrantType, code, "machine", now)
		return err
	})
	var grant *core.DeviceGrantError
	if !errors.As(err, &grant) || grant.Code != "invalid_grant" {
		t.Fatalf("replay=%v", err)
	}
	var count int
	requireNoError(t, db.Pool.QueryRow(ctx, `SELECT count(*) FROM personal_access_tokens WHERE user_id=$1`, user.ID).Scan(&count))
	if count != 1 {
		t.Fatalf("token count=%d", count)
	}
}

func TestScopedDeviceLockWaitRechecksExpiry(t *testing.T) {
	for _, mode := range []string{"decision", "redemption"} {
		t.Run(mode, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			user, session, _ := testutil.AuthRecords(t, db)
			now := time.Now().UTC().Truncate(time.Microsecond)
			code := secret.Random("")
			var expiry time.Time
			requireNoError(t, db.Pool.QueryRow(ctx, `SELECT clock_timestamp()+interval '1 second'`).Scan(&expiry))
			device := model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: secret.Hash(code), UserCode: "BCDFGHJKLM", CreatedAt: now, ExpiresAt: expiry, NextPollAt: now, PollIntervalSeconds: 5}
			identityScopeTest(t, db, func(s store.IdentityScope) error {
				dao := s.IdentityDAO()
				if err := dao.InsertDevice(ctx, device); err != nil {
					return err
				}
				if mode == "redemption" {
					return dao.(store.DeviceScopeDAO).SetScopedDeviceDecision(ctx, device.ID, "approved", user.ID, []scopepolicy.ScopeID{"task:read"})
				}
				return nil
			})
			holder, err := db.Pool.Begin(ctx)
			requireNoError(t, err)
			_, err = holder.Exec(ctx, `SELECT id FROM device_authorizations WHERE id=$1 FOR UPDATE`, device.ID)
			requireNoError(t, err)
			waiter, err := db.Pool.Begin(ctx)
			requireNoError(t, err)
			scope := pgidentity.NewScope(waiter, oauth.NewDAO(waiter))
			dao := scope.IdentityDAO()
			done := make(chan error, 1)
			finished := false
			defer func() {
				cancel()
				_ = holder.Rollback(context.Background())
				if !finished {
					select {
					case <-done:
					case <-time.After(5 * time.Second):
						t.Error("waiter did not exit")
					}
				}
				_ = waiter.Rollback(context.Background())
			}()
			go func() {
				m := core.NewIdentity("")
				if mode == "decision" {
					done <- m.DecideDeviceScoped(ctx, dao, dao.(store.DeviceScopeDAO), session, device.UserCode, "approve", user.ID, []scopepolicy.ScopeID{"task:read"}, now)
				} else {
					_, e := m.RedeemDeviceScoped(ctx, dao, dao.(store.DeviceScopeDAO), core.DeviceClientID, core.DeviceGrantType, code, "machine", now)
					done <- e
				}
			}()
			for {
				var blocked bool
				requireNoError(t, db.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2::integer))`, int32(holder.Conn().PgConn().PID()), int32(waiter.Conn().PgConn().PID())).Scan(&blocked))
				if blocked {
					break
				}
				select {
				case e := <-done:
					finished = true
					t.Fatalf("waiter finished early: %v", e)
				case <-ctx.Done():
					t.Fatal("lock wait not observed")
				case <-time.After(10 * time.Millisecond):
				}
			}
			for {
				var expired bool
				requireNoError(t, db.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1`, expiry).Scan(&expired))
				if expired {
					break
				}
				select {
				case <-ctx.Done():
					t.Fatal("expiry not observed")
				case <-time.After(10 * time.Millisecond):
				}
			}
			requireNoError(t, holder.Commit(ctx))
			select {
			case e := <-done:
				finished = true
				if mode == "decision" {
					var f *model.Fault
					if !errors.As(e, &f) || f.Code != "invalid_transition" {
						t.Fatalf("decision=%v", e)
					}
				} else {
					var g *core.DeviceGrantError
					if !errors.As(e, &g) || g.Code != "expired_token" {
						t.Fatalf("redemption=%v", e)
					}
				}
			case <-ctx.Done():
				t.Fatal("waiter did not finish")
			}
			requireNoError(t, waiter.Rollback(ctx))
			var status string
			var count int
			requireNoError(t, db.Pool.QueryRow(ctx, `SELECT status,(SELECT count(*) FROM personal_access_tokens WHERE user_id=$2) FROM device_authorizations WHERE id=$1`, device.ID, user.ID).Scan(&status, &count))
			expected := "pending"
			if mode == "redemption" {
				expected = "approved"
			}
			if status != expected || count != 0 {
				t.Fatalf("expired status=%s count=%d", status, count)
			}
		})
	}
}

func TestScopedDeviceConcurrentRedemptionIssuesOnePAT(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, session, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	code := secret.Random("")
	device := model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: secret.Hash(code), UserCode: "BCDFGHJKLM", CreatedAt: now, ExpiresAt: now.Add(time.Minute), NextPollAt: now, PollIntervalSeconds: 5}
	module := core.NewIdentity("")
	identityScopeTest(t, db, func(s store.IdentityScope) error {
		dao := s.IdentityDAO()
		if err := dao.InsertDevice(ctx, device); err != nil {
			return err
		}
		return module.DecideDeviceScoped(ctx, dao, dao.(store.DeviceScopeDAO), session, device.UserCode, "approve", user.ID, []scopepolicy.ScopeID{"task:read"}, now)
	})
	first, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	second, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	firstDAO := pgidentity.NewScope(first, oauth.NewDAO(first)).IdentityDAO()
	secondDAO := pgidentity.NewScope(second, oauth.NewDAO(second)).IdentityDAO()
	minted, err := module.RedeemDeviceScoped(ctx, firstDAO, firstDAO.(store.DeviceScopeDAO), core.DeviceClientID, core.DeviceGrantType, code, "one", now)
	requireNoError(t, err)
	done := make(chan error, 1)
	finished := false
	defer func() {
		cancel()
		_ = first.Rollback(context.Background())
		if !finished {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("waiter did not exit")
			}
		}
		_ = second.Rollback(context.Background())
	}()
	go func() {
		_, e := module.RedeemDeviceScoped(ctx, secondDAO, secondDAO.(store.DeviceScopeDAO), core.DeviceClientID, core.DeviceGrantType, code, "two", now)
		done <- e
	}()
	for {
		var blocked bool
		requireNoError(t, db.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2::integer))`, int32(first.Conn().PgConn().PID()), int32(second.Conn().PgConn().PID())).Scan(&blocked))
		if blocked {
			break
		}
		select {
		case e := <-done:
			finished = true
			t.Fatalf("second redemption returned before lock: %v", e)
		case <-ctx.Done():
			t.Fatal("redemption lock wait not observed")
		case <-time.After(10 * time.Millisecond):
		}
	}
	requireNoError(t, first.Commit(ctx))
	select {
	case e := <-done:
		finished = true
		var grant *core.DeviceGrantError
		if !errors.As(e, &grant) || grant.Code != "invalid_grant" {
			t.Fatalf("second redemption: %v", e)
		}
	case <-ctx.Done():
		t.Fatal("redemption waiter did not finish")
	}
	requireNoError(t, second.Rollback(ctx))
	var count int
	requireNoError(t, db.Pool.QueryRow(ctx, `SELECT count(*) FROM personal_access_tokens WHERE user_id=$1`, user.ID).Scan(&count))
	if count != 1 {
		t.Fatalf("PAT count=%d", count)
	}
	identityScopeTest(t, db, func(s store.IdentityScope) error {
		pat, e := s.IdentityDAO().(store.PATScopeDAO).PATByHash(ctx, secret.Hash(minted.Secret), now)
		if e != nil {
			return e
		}
		if pat.ID != minted.Credential.ID || !slices.Equal(pat.ScopePolicy.Scopes(), []scopepolicy.ScopeID{"task:read"}) {
			t.Fatalf("minted PAT=%+v", pat)
		}
		return nil
	})
}

type lostDecisionReceiptWriter struct {
	store.IdentityWriter
	calls int
}

func (w *lostDecisionReceiptWriter) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	w.calls++
	completion, err := w.IdentityWriter.WriteIdentity(ctx, fn)
	if w.calls == 2 && err == nil && completion.Outcome == store.TransactionCommitted {
		return store.Completion{Outcome: store.TransactionUnknown}, nil
	}
	return completion, err
}

func TestScopedDeviceUnknownDecisionReadback(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, session, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	device := model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: secret.Hash(secret.Random("")), UserCode: "BCDFGHJKLM", CreatedAt: now, ExpiresAt: now.Add(time.Minute), NextPollAt: now, PollIntervalSeconds: 5}
	identityScopeTest(t, db, func(s store.IdentityScope) error { return s.IdentityDAO().InsertDevice(ctx, device) })
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"project:read", "task:read"})
	requireNoError(t, err)
	writer := &lostDecisionReceiptWriter{IdentityWriter: db}
	service := serviceidentity.NewWithDeviceScopes(writer, nil, "", catalog)
	err = service.DecideDeviceV2(ctx, session, device.UserCode, "approve", user.ID, catalog.CatalogRevision, []scopepolicy.ScopeID{"task:read"})
	var transaction *store.TransactionError
	if !errors.As(err, &transaction) || transaction.Outcome != store.TransactionUnknown || writer.calls != 2 {
		t.Fatalf("expected unknown decision after one write, calls=%d err=%v", writer.calls, err)
	}
	view, err := service.InspectDeviceV2(ctx, session, device.UserCode)
	requireNoError(t, err)
	if view.UserCode != "BCDFG-HJKLM" || view.Status != "approved" || view.CatalogRevision != nil || writer.calls != 4 {
		t.Fatalf("readback=%+v calls=%d", view, writer.calls)
	}
	identityScopeTest(t, db, func(s store.IdentityScope) error {
		d, e := s.IdentityDAO().DeviceByUserCode(ctx, user.ID, device.UserCode, false)
		if e != nil {
			return e
		}
		if d.UserID == nil || *d.UserID != user.ID || !slices.Equal(d.ApprovedScopes, []scopepolicy.ScopeID{"task:read"}) {
			t.Fatalf("decision=%+v", d)
		}
		return nil
	})
}

func TestScopedDeviceDecisionStorageRejectsInvalidAndStoresDenial(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, _, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	device := model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: secret.Hash(secret.Random("")), UserCode: "BCDFGHJKLM", CreatedAt: now, ExpiresAt: now.Add(time.Minute), NextPollAt: now, PollIntervalSeconds: 5}
	identityScopeTest(t, db, func(s store.IdentityScope) error { return s.IdentityDAO().InsertDevice(ctx, device) })
	identityScopeTest(t, db, func(s store.IdentityScope) error {
		dao := s.IdentityDAO().(store.DeviceScopeDAO)
		for _, tc := range []struct {
			status string
			scopes []scopepolicy.ScopeID
		}{
			{"approved", nil}, {"approved", []scopepolicy.ScopeID{"task:read", "task:read"}}, {"denied", []scopepolicy.ScopeID{"task:read"}}, {"pending", nil},
		} {
			if err := dao.SetScopedDeviceDecision(ctx, device.ID, tc.status, user.ID, tc.scopes); err == nil {
				t.Fatalf("accepted %s %v", tc.status, tc.scopes)
			}
		}
		return dao.SetScopedDeviceDecision(ctx, device.ID, "denied", user.ID, nil)
	})
	identityScopeTest(t, db, func(s store.IdentityScope) error {
		d, err := s.IdentityDAO().DeviceByUserCode(ctx, user.ID, device.UserCode, false)
		if err != nil {
			return err
		}
		if d.Status != "denied" || d.UserID == nil || *d.UserID != user.ID || d.ApprovedScopes != nil {
			t.Fatalf("denied device: %+v", d)
		}
		return nil
	})
}
