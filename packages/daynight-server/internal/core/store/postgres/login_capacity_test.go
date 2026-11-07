package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

type loginAdmissionResult struct {
	code  string
	stamp time.Time
	err   error
}

func TestLoginConsumeChecksExpiryAfterRowLockWait(t *testing.T) {
	database := isolatedStore(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	state, binding := deviceStoreHash("waiting-state"), deviceStoreHash("waiting-binding")
	id := uuid.NewString()
	if _, err := database.Pool.Exec(ctx, `INSERT INTO login_transactions(id,state_hash,browser_binding_hash,provider,return_path,expires_at,scope_hash) VALUES ($1,$2,$3,'github','/',clock_timestamp()+interval '10 minutes',$4)`, id, state, binding, deviceStoreHash("scope")); err != nil {
		t.Fatal(err)
	}
	blocker, err := database.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `SELECT id FROM login_transactions WHERE id=$1 FOR UPDATE`, id); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
			_, err := scope.IdentityDAO().ConsumeLogin(ctx, state, binding, time.Now())
			return err
		})
		result <- err
	}()
	for {
		var waiting bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE 'SELECT id::text FROM login_transactions WHERE state_hash=%')`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("timed out waiting for the login row lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
	if _, err := blocker.Exec(ctx, `UPDATE login_transactions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-result; !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("callback consumed an expired login after waiting: %v", err)
	}
	var rows int
	if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM login_transactions WHERE id=$1`, id).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("expired transaction changed: %d %v", rows, err)
	}
}

func startLoginAdmission(ctx context.Context, database *Store, hash []byte, admitted chan<- struct{}, release <-chan struct{}) <-chan loginAdmissionResult {
	result := make(chan loginAdmissionResult, 1)
	go func() {
		var response loginAdmissionResult
		_, response.err = database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
			dao := scope.IdentityDAO()
			var err error
			response.stamp, response.code, err = dao.AdmitLogin(ctx, hash, 10000, 5)
			if err != nil || response.code != "" {
				return err
			}
			if admitted != nil {
				close(admitted)
				select {
				case <-release:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			if err := dao.CleanupLoginCredentials(ctx, response.stamp, time.Now()); err != nil {
				return err
			}
			value := uuid.NewString()
			return dao.InsertLogin(ctx, model.LoginTransaction{ID: value, StateHash: deviceStoreHash(value), BrowserBindingHash: deviceStoreHash("binding"), ScopeHash: hash, Provider: "github", ReturnPath: "/", ExpiresAt: response.stamp.Add(10 * time.Minute)})
		})
		result <- response
	}()
	return result
}

func waitForLoginLock(t *testing.T, ctx context.Context, database *Store) {
	t.Helper()
	for {
		var waiting bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=4476492 AND objid=1330071886)`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatal("timed out waiting for the competing admission lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestLoginCapacitySerializedAcrossInstances(t *testing.T) {
	for _, mode := range []string{"scope", "global"} {
		t.Run(mode, func(t *testing.T) {
			database := isolatedStore(t)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			scopeA, scopeB := deviceStoreHash("scope-a"), deviceStoreHash("scope-b")
			count := 4
			if mode == "global" {
				count = 9999
			}
			_, err := database.Pool.Exec(ctx, `INSERT INTO login_transactions(id,state_hash,browser_binding_hash,provider,return_path,expires_at,scope_hash)
 SELECT md5('login'||n)::uuid,sha256(('state'||n)::bytea),sha256('binding'::bytea),'github','/',clock_timestamp()+interval '10 minutes',
 CASE WHEN $2 THEN sha256(('scope'||n)::bytea) ELSE $3 END FROM generate_series(1,$1) n`, count, mode == "global", scopeA)
			if err != nil {
				t.Fatal(err)
			}
			ready, release := make(chan struct{}), make(chan struct{})
			first := startLoginAdmission(ctx, database, scopeA, ready, release)
			select {
			case <-ready:
			case <-ctx.Done():
				t.Fatal("first admission did not acquire the lock")
			}
			secondScope := scopeA
			if mode == "global" {
				secondScope = scopeB
			}
			second := startLoginAdmission(ctx, &Store{Pool: database.Pool}, secondScope, nil, nil)
			waitForLoginLock(t, ctx, database)
			var released time.Time
			if err := database.Pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&released); err != nil {
				t.Fatal(err)
			}
			close(release)
			a, b := <-first, <-second
			want := "rate_limited"
			if mode == "global" {
				want = "capacity_exhausted"
			}
			if a.err != nil || a.code != "" || b.err != nil || b.code != want || b.stamp.Before(released) {
				t.Fatalf("admission: first=%+v second=%+v lock released=%s", a, b, released)
			}
			var actual int
			if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM login_transactions WHERE expires_at>clock_timestamp()`).Scan(&actual); err != nil || actual != count+1 {
				t.Fatalf("unexpected active count %d: %v", actual, err)
			}
			// A quota rejection must not clean up expired rows.
			_, err = database.Pool.Exec(ctx, `INSERT INTO login_transactions(id,state_hash,browser_binding_hash,provider,return_path,expires_at,scope_hash)
 VALUES($1,$2,$3,'github','/',clock_timestamp()-interval '1 minute',$4)`, uuid.NewString(), deviceStoreHash("expired-"+mode), deviceStoreHash("binding"), scopeA)
			if err != nil {
				t.Fatal(err)
			}
			rejected := <-startLoginAdmission(ctx, database, secondScope, nil, nil)
			if rejected.err != nil || rejected.code != want {
				t.Fatalf("rejection: %+v", rejected)
			}
			if err := database.Pool.QueryRow(ctx, `SELECT count(*) FROM login_transactions WHERE expires_at<=clock_timestamp()`).Scan(&actual); err != nil || actual != 1 {
				t.Fatalf("rejection changed expired rows: %d %v", actual, err)
			}
			if mode == "scope" {
				other := <-startLoginAdmission(ctx, database, scopeB, nil, nil)
				if other.err != nil || other.code != "" {
					t.Fatalf("another scope was blocked: %+v", other)
				}
				_, err = database.Pool.Exec(ctx, `UPDATE login_transactions SET expires_at=clock_timestamp()-interval '1 second' WHERE scope_hash=$1`, scopeA)
				if err != nil {
					t.Fatal(err)
				}
				afterExpiry := <-startLoginAdmission(ctx, database, scopeA, nil, nil)
				if afterExpiry.err != nil || afterExpiry.code != "" {
					t.Fatalf("expired scope still consumes quota: %+v", afterExpiry)
				}
			}
		})
	}
}
