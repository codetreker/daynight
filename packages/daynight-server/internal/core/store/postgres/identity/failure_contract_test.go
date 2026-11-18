package identity_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestIdentityUnavailableRelationsPreserveOperationalFailure(t *testing.T) {
	db := isolatedStore(t)
	_, p, session := testutil.AuthRecords(t, db)
	for _, operation := range []string{"create-login", "upsert-user", "ensure-user", "patch-user", "insert-session", "insert-pat", "list-pat", "delete-pat", "delete-session", "consume-login", "authenticate", "user", "insert-device", "inspect-device", "decide-device", "redeem-device", "device-rate", "expiry"} {
		if !t.Run(operation, func(t *testing.T) {
			ctx := t.Context()
			now := time.Now().UTC()
			table := "personal_access_tokens"
			switch operation {
			case "create-login", "consume-login":
				table = "login_transactions"
			case "upsert-user", "ensure-user", "patch-user", "user":
				table = "users"
			case "insert-session", "delete-session", "authenticate":
				table = "sessions"
			case "insert-device", "inspect-device", "decide-device", "redeem-device":
				table = "device_authorizations"
			case "device-rate":
				table = "device_authorization_limits"
			}
			var originalOID uint32
			if err := db.Pool.QueryRow(ctx, `SELECT to_regclass($1)::oid`, table).Scan(&originalOID); err != nil {
				t.Fatal(err)
			}
			relation := pgx.Identifier{table}.Sanitize()
			unavailable := "unavailable_" + table
			renamed := pgx.Identifier{unavailable}.Sanitize()
			if _, err := db.Pool.Exec(ctx, `ALTER TABLE `+relation+` RENAME TO `+renamed); err != nil {
				t.Fatal(err)
			}
			// A prepared statement can still reach a renamed relation. Start the
			// fault transaction on a connection that has to resolve the SQL anew.
			db.Pool.Reset()
			completion, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
				dao := sc.IdentityDAO()
				switch operation {
				case "create-login":
					return dao.InsertLogin(ctx, model.LoginTransaction{ID: uuid.NewString()})
				case "consume-login":
					_, err := dao.ConsumeLogin(ctx, testutil.DeviceHash("state"), testutil.DeviceHash("binding"), now)
					return err
				case "upsert-user":
					_, err := dao.UpsertUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: "new"}, now)
					return err
				case "ensure-user":
					_, _, err := dao.EnsureUser(ctx, model.User{ID: uuid.NewString(), UniAuthID: "new"}, now)
					return err
				case "patch-user":
					_, err := dao.PatchUser(ctx, p.UserID, model.UserProfilePatch{Name: model.ProfileField{Present: true}})
					return err
				case "insert-session":
					fresh := session
					fresh.ID = uuid.NewString()
					fresh.UserID = p.UserID
					fresh.TokenHash = testutil.DeviceHash(fresh.ID)
					return dao.InsertSession(ctx, fresh)
				case "insert-pat":
					return dao.InsertPAT(ctx, testutil.DeviceCredential(now))
				case "list-pat":
					_, err := dao.ListPATs(ctx, p.UserID, now)
					return err
				case "delete-pat":
					return dao.DeletePAT(ctx, p.UserID, uuid.NewString())
				case "delete-session":
					return dao.DeleteSession(ctx, p)
				case "authenticate":
					_, err := dao.Authenticate(ctx, model.SessionCredential, session.TokenHash, now)
					return err
				case "user":
					_, _, err := dao.IdentityUser(ctx, p.UserID)
					return err
				case "insert-device":
					return dao.InsertDevice(ctx, model.DeviceAuthorization{})
				case "inspect-device":
					_, err := dao.DeviceByUserCode(ctx, p.UserID, "BCDFGHJKLM", false)
					return err
				case "decide-device":
					_, err := dao.DeviceByUserCode(ctx, p.UserID, "BCDFGHJKLM", true)
					return err
				case "redeem-device":
					_, err := dao.LockDeviceByHash(ctx, testutil.DeviceHash("device"))
					return err
				case "device-rate":
					_, err := dao.IncrementDeviceRate(ctx, model.DeviceRateBucket{Hash: testutil.DeviceHash("rate"), Limit: 30}, now)
					return err
				case "expiry":
					_, err := dao.LockActivePAT(ctx, p.UserID, uuid.NewString(), now)
					return err
				}
				panic("unhandled operation")
			})
			var pg *pgconn.PgError
			var dbError *store.Error
			if !errors.As(err, &pg) || pg.Code != "42P01" || !errors.As(err, &dbError) || strings.Contains(err.Error(), "SELECT") || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("relation failure=%#v %v (PostgreSQL: %v)", completion, err, pg)
			}
			if operation == "user" {
				t.Run("authenticate-session", func(t *testing.T) {
					ctx := t.Context()
					var authenticationError *store.Error
					var driver *pgconn.PgError
					completion, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
						principal, err := sc.IdentityDAO().Authenticate(ctx, model.SessionCredential, session.TokenHash, now)
						if principal != (model.Principal{Kind: model.SessionCredential}) {
							t.Fatalf("failed Session authentication returned actor data: %#v", principal)
						}
						if !errors.As(err, &authenticationError) || !authenticationError.DatabaseFailure ||
							!errors.As(err, &driver) || driver.Code != "42P01" || errors.Is(err, model.ErrNotFound) {
							t.Fatalf("missing users relation lost its authentication failure cause: %v", err)
						}
						return err
					})
					if completion.Outcome != store.TransactionNotCommitted || authenticationError == nil || !errors.Is(err, authenticationError) || !errors.Is(err, driver) {
						t.Fatalf("failed Session authentication lost its rollback outcome or cause: %+v %v", completion, err)
					}
				})
			}
			if _, err := db.Pool.Exec(ctx, `ALTER TABLE `+renamed+` RENAME TO `+relation); err != nil {
				t.Fatal(err)
			}
			var restored bool
			if err := db.Pool.QueryRow(ctx, `SELECT to_regclass($1)::oid IS NOT DISTINCT FROM $2::oid AND to_regclass($3) IS NULL`,
				table, originalOID, unavailable).Scan(&restored); err != nil || !restored {
				t.Fatalf("restore %s as relation %d: restored=%t error=%v", table, originalOID, restored, err)
			}
		}) {
			return
		}
	}

	pool, err := pgxpool.NewWithConfig(t.Context(), db.Pool.Config())
	if err != nil {
		t.Fatal(err)
	}
	pool.Close()
	closed := &postgres.Store{Pool: pool}
	for _, operation := range []func(store.IdentityDAO) error{
		func(d store.IdentityDAO) error { return d.InsertLogin(context.Background(), model.LoginTransaction{}) },
		func(d store.IdentityDAO) error {
			_, err := d.UpsertUser(context.Background(), model.User{}, time.Now())
			return err
		},
		func(d store.IdentityDAO) error {
			_, err := d.ListPATs(context.Background(), "", time.Now())
			return err
		},
	} {
		called := false
		_, err := closed.WriteIdentity(t.Context(), func(sc store.IdentityScope) error { called = true; return operation(sc.IdentityDAO()) })
		if err == nil || called {
			t.Fatalf("closed pool ran operation: called=%t error=%v", called, err)
		}
	}
}

func TestDeviceRateAndGrantCleanupRetainsOriginalBounds(t *testing.T) {
	tx, sc := identityTransaction(t)
	ctx, dao := t.Context(), sc.IdentityDAO()
	now := time.Now().UTC().Truncate(time.Microsecond)
	global, actor := model.DeviceRateBucket{Hash: hash("global-original"), Limit: 4}, model.DeviceRateBucket{Hash: hash("actor-original"), Limit: 2}
	for _, b := range []model.DeviceRateBucket{global, actor} {
		for _, want := range []int{1, 2, 3} {
			got, err := dao.IncrementDeviceRate(ctx, b, now)
			requireNoError(t, err)
			if got != min(want, b.Limit+1) {
				t.Fatalf("attempts=%d want=%d", got, want)
			}
		}
	}
	_, err := tx.Exec(ctx, `INSERT INTO device_authorization_limits(bucket_hash,attempts,expires_at) SELECT sha256(i::text::bytea),1,$1 FROM generate_series(1,200)i`, now.Add(-time.Minute))
	requireNoError(t, err)
	requireNoError(t, dao.PruneDeviceRates(ctx, now.Add(time.Minute)))
	// Expired buckets reset independently of which hundred rows pruning selected.
	for _, b := range []model.DeviceRateBucket{global, actor} {
		got, err := dao.IncrementDeviceRate(ctx, b, now.Add(time.Minute))
		requireNoError(t, err)
		if got != 1 {
			t.Fatalf("rate reset depended on cleanup: %d", got)
		}
	}
	var count int
	requireNoError(t, tx.QueryRow(ctx, `SELECT count(*) FROM device_authorization_limits WHERE expires_at<=$1`, now).Scan(&count))
	if count != 100 {
		t.Fatalf("bounded rate cleanup=%d", count)
	}
	_, err = tx.Exec(ctx, `INSERT INTO device_authorizations(id,device_code_hash,user_code,status,created_at,expires_at,next_poll_at,poll_interval_seconds) SELECT md5(i::text)::uuid,sha256(i::text::bytea),'BCDFGHJKL'||substring('BCDFGHJKLMNPQRSTVWXZ' from i for 1),'pending',$1::timestamptz-interval '3 hours',$1::timestamptz-interval '2 hours',$1,5 FROM generate_series(1,20)i`, now)
	requireNoError(t, err)
	requireNoError(t, dao.PruneDevices(ctx, now))
	requireNoError(t, dao.InsertDevice(ctx, model.DeviceAuthorization{ID: uuid.NewString(), DeviceCodeHash: hash("live-device"), UserCode: "BCDFGHJKLM", CreatedAt: now, ExpiresAt: now.Add(time.Hour), NextPollAt: now, PollIntervalSeconds: 5}))
	requireNoError(t, tx.QueryRow(ctx, `SELECT count(*) FROM device_authorizations`).Scan(&count))
	if count != 1 {
		t.Fatalf("expired grants retained=%d", count)
	}
}
