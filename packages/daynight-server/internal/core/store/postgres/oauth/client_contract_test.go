package oauth_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgOAuth "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func isolatedStore(t *testing.T) *postgres.Store {
	t.Helper()
	return testutil.OpenStore(t, postgres.Open)
}

func TestOAuthClientCapacityAndRetention(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	client := func(id string, at time.Time) store.OAuthClient {
		return store.OAuthClient{ID: id, Metadata: []byte(`{"redirect_uris":["https://client.test/"]}`), CreatedAt: at, LastUsedAt: at, ExpiresAt: at.Add(7 * 24 * time.Hour)}
	}
	insert := func(c store.OAuthClient, cap int) bool {
		t.Helper()
		var ok bool
		_, err := db.WriteOAuthClients(ctx, func(s store.OAuthClientScope) error {
			var err error
			ok, err = s.OAuthClientDAO().InsertClient(ctx, c, cap, now)
			return err
		})
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !insert(client("first", now.Add(-8*24*time.Hour)), 1) || insert(client("second", now), 1) {
		t.Fatal("capacity not enforced")
	}
	_, err := db.WriteOAuthClients(ctx, func(s store.OAuthClientScope) error {
		_, err := s.OAuthClientDAO().PinClient(ctx, "first", now)
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("expired unreferenced pin: %v", err)
	}
	var candidates []string
	_, err = db.WriteOAuthClients(ctx, func(s store.OAuthClientScope) error {
		dao := s.OAuthClientDAO()
		var err error
		candidates, err = dao.ExpiredClients(ctx, now, 100)
		if err != nil {
			return err
		}
		if len(candidates) != 1 || candidates[0] != "first" {
			return fmt.Errorf("expired candidates: %v", candidates)
		}
		return dao.DeleteClient(ctx, candidates[0])
	})
	if err != nil {
		t.Fatal(err)
	}
	if !insert(client("second", now), 1) {
		t.Fatal("capacity was not released")
	}
	_, err = db.WriteOAuthClients(ctx, func(s store.OAuthClientScope) error {
		c, err := s.OAuthClientDAO().PinClient(ctx, "second", now)
		if err != nil {
			return err
		}
		if c.ID != "second" || !c.ExpiresAt.After(now) {
			t.Fatalf("pin: %+v", c)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestOAuthClientCleanupWaitsForIssuance(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	old := now.Add(-8 * 24 * time.Hour)
	_, err := db.WriteOAuthClients(ctx, func(s store.OAuthClientScope) error {
		_, err := s.OAuthClientDAO().InsertClient(ctx, store.OAuthClient{ID: "pinned", Metadata: []byte(`{}`), CreatedAt: old, LastUsedAt: old, ExpiresAt: old.Add(7 * 24 * time.Hour)}, 100, now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	dao := pgOAuth.NewDAO(tx)
	if _, err := dao.Client(ctx, "pinned", true); err != nil {
		t.Fatal(err)
	}
	issue := store.OAuthFamilyIssue{Grant: store.OAuthGrant{ID: uuid.NewString(), UserID: uuid.NewString(), ClientID: "pinned", ClientSnapshot: []byte(`{}`), Resource: "resource", Scope: "scope", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, AccessID: uuid.NewString(), AccessHash: make([]byte, 32), RefreshHash: make([]byte, 32), AccessExpiresAt: now.Add(time.Minute)}
	if err := dao.IssueFamily(ctx, issue); err != nil {
		t.Fatal(err)
	}
	type result struct {
		active bool
		err    error
	}
	done := make(chan result, 1)
	go func() {
		var active bool
		_, err := db.WriteOAuthClients(ctx, func(s store.OAuthClientScope) error {
			if err := s.OAuthClientDAO().LockClientCapacity(ctx); err != nil {
				return err
			}
			if _, err := s.OAuthClientDAO().Client(ctx, "pinned", true); err != nil {
				return err
			}
			var err error
			active, err = s.CredentialFamilyDAO().ActiveClientReferences(ctx, "pinned", now)
			return err
		})
		done <- result{active, err}
	}()
	// Observe the client row wait before publishing the grant reference.
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting bool
		err := db.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE '%FROM oauth_clients WHERE id=%')`).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("cleanup did not wait for client lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	got := <-done
	if got.err != nil || !got.active {
		t.Fatalf("references after issuance: %+v", got)
	}
	_, err = db.WriteOAuthClients(ctx, func(s store.OAuthClientScope) error {
		_, err := s.OAuthClientDAO().PinClient(ctx, "pinned", now)
		return err
	})
	if err != nil {
		t.Fatalf("referenced client removed: %v", err)
	}
}

func TestOAuthClientConcurrentCapacity(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted := 0
	var failures []error
	for i := range 12 {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var inserted bool
			_, err := db.WriteOAuthClients(ctx, func(s store.OAuthClientScope) error {
				var err error
				inserted, err = s.OAuthClientDAO().InsertClient(ctx, store.OAuthClient{ID: fmt.Sprintf("client-%d", i), Metadata: []byte(`{}`), CreatedAt: now, LastUsedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour)}, 3, now)
				return err
			})
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failures = append(failures, err)
			}
			if inserted {
				accepted++
			}
		}(i)
	}
	wg.Wait()
	if accepted != 3 || len(failures) != 0 {
		t.Fatalf("accepted=%d errors=%v", accepted, failures)
	}
}

func TestOAuthClientStorageRefusals(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	c := store.OAuthClient{ID: "client", Metadata: []byte(`{}`), CreatedAt: now, LastUsedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour)}
	t.Run("invalid capacity and missing pin", func(t *testing.T) {
		_, err := db.WriteOAuthClients(ctx, func(s store.OAuthClientScope) error {
			if ok, err := s.OAuthClientDAO().InsertClient(ctx, c, 0, now); ok || err == nil {
				t.Fatal("invalid capacity accepted")
			}
			if _, err := s.OAuthClientDAO().PinClient(ctx, "absent", now); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("missing client: %v", err)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	})
	t.Run("duplicate insertion", func(t *testing.T) {
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		dao := pgOAuth.NewDAO(tx)
		if ok, err := dao.InsertClient(ctx, c, 10, now); !ok || err != nil {
			t.Fatalf("first insert: %v %v", ok, err)
		}
		if ok, err := dao.InsertClient(ctx, c, 10, now); ok || err == nil {
			t.Fatalf("duplicate insert: %v %v", ok, err)
		}
	})
	t.Run("missing reference storage", func(t *testing.T) {
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		dao := pgOAuth.NewDAO(tx)
		old := now.Add(-8 * 24 * time.Hour)
		stale := store.OAuthClient{ID: "stale", Metadata: []byte(`{}`), CreatedAt: old, LastUsedAt: old, ExpiresAt: old.Add(7 * 24 * time.Hour)}
		if ok, err := dao.InsertClient(ctx, stale, 10, now); !ok || err != nil {
			t.Fatalf("insert: %v %v", ok, err)
		}
		if _, err := tx.Exec(ctx, `DROP TABLE oauth_grants`); err != nil {
			t.Fatal(err)
		}
		if _, err := dao.PinClient(ctx, "stale", now); err == nil {
			t.Fatal("pin ignored reference lookup failure")
		}
	})
	t.Run("capacity query failure", func(t *testing.T) {
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `DROP TABLE oauth_grants`); err != nil {
			t.Fatal(err)
		}
		if ok, err := pgOAuth.NewDAO(tx).InsertClient(ctx, c, 10, now); ok || err == nil {
			t.Fatalf("count failure: %v %v", ok, err)
		}
	})
	t.Run("cancelled capacity lock", func(t *testing.T) {
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		if ok, err := pgOAuth.NewDAO(tx).InsertClient(cancelled, c, 10, now); ok || err == nil {
			t.Fatalf("lock failure: %v %v", ok, err)
		}
	})
	t.Run("future last use is monotonic", func(t *testing.T) {
		future := now.Add(time.Hour)
		c.ID = "future"
		c.CreatedAt = now
		c.LastUsedAt = future
		c.ExpiresAt = future.Add(7 * 24 * time.Hour)
		_, err := db.WriteOAuthClients(ctx, func(s store.OAuthClientScope) error {
			if ok, err := s.OAuthClientDAO().InsertClient(ctx, c, 10, now); !ok || err != nil {
				return fmt.Errorf("insert: %v", err)
			}
			pinned, err := s.OAuthClientDAO().PinClient(ctx, c.ID, now)
			if err != nil {
				return err
			}
			if !pinned.LastUsedAt.Equal(future) || !pinned.ExpiresAt.Equal(c.ExpiresAt) {
				return fmt.Errorf("pin moved time backwards")
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	})
}

func TestPinnedClientCleanupObservesCommittedGrant(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	now := time.Now().UTC().Truncate(time.Microsecond)
	client := store.OAuthClient{ID: "pinned-issuance-client", Metadata: []byte(`{}`), CreatedAt: now, LastUsedAt: now, ExpiresAt: now.Add(7 * 24 * time.Hour)}
	issue := family(now, client.ID)
	_, err := db.Pool.Exec(ctx, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,$2,$2)`, issue.Grant.UserID, now)
	check(t, err)
	tx, err := db.Pool.Begin(ctx)
	check(t, err)
	defer tx.Rollback(context.Background())
	inserted, err := pgOAuth.NewDAO(tx).InsertClient(ctx, client, 100, now)
	check(t, err)
	if !inserted {
		t.Fatal("issuance client was not inserted")
	}
	check(t, tx.Commit(ctx))
	holder, err := db.Pool.Begin(ctx)
	check(t, err)
	defer holder.Rollback(context.Background())
	pinAt := now.Add(time.Minute)
	pinned, err := pgOAuth.NewDAO(holder).PinClient(ctx, client.ID, pinAt)
	check(t, err)
	if !pinned.LastUsedAt.Equal(pinAt) || !pinned.ExpiresAt.Equal(pinAt.Add(7*24*time.Hour)) {
		t.Fatalf("actual client pin did not touch retention: %+v", pinned)
	}
	check(t, pgOAuth.NewDAO(holder).IssueFamily(ctx, issue))
	conn, err := db.Pool.Acquire(ctx)
	check(t, err)
	pid, socket := conn.Conn().PgConn().PID(), conn.Conn().PgConn().Conn()
	workerCtx, stop := context.WithCancel(ctx)
	type observation struct {
		client store.OAuthClient
		active bool
	}
	cleanupAt := now.Add(8 * 24 * time.Hour)
	result, done := startOAuthReceiverTransaction(workerCtx, conn, func(tx pgx.Tx) (observation, error) {
		dao := pgOAuth.NewDAO(tx)
		if err := dao.LockClientCapacity(workerCtx); err != nil {
			return observation{}, err
		}
		client, err := dao.Client(workerCtx, client.ID, true)
		if err != nil {
			return observation{}, err
		}
		active, err := dao.ActiveClientReferences(workerCtx, client.ID, cleanupAt)
		return observation{client, active}, err
	})
	defer drainOAuthReceiverTransaction(t, stop, holder, socket, done)
	awaitOAuthReceiverLock(t, ctx, db.Pool, holder.Conn().PgConn().PID(), pid, done)
	check(t, holder.Commit(ctx))
	select {
	case out := <-result:
		if out.err != nil || !out.value.active || out.value.client.ID != client.ID || !out.value.client.LastUsedAt.Equal(pinned.LastUsedAt) || !out.value.client.ExpiresAt.Equal(pinned.ExpiresAt) {
			t.Fatalf("cleanup missed committed pinned grant: %+v error=%v", out.value, out.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var clients, grants, matchingGrants int
	var lastUsed, expires time.Time
	check(t, db.Pool.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM oauth_clients WHERE id=$1),
 (SELECT count(*) FROM oauth_grants),
 (SELECT count(*) FROM oauth_grants WHERE id=$2 AND client_id=$1),
 (SELECT last_used_at FROM oauth_clients WHERE id=$1),
 (SELECT expires_at FROM oauth_clients WHERE id=$1)`, client.ID, issue.Grant.ID).Scan(&clients, &grants, &matchingGrants, &lastUsed, &expires))
	if clients != 1 || grants != 1 || matchingGrants != 1 || !lastUsed.Equal(pinned.LastUsedAt) || !expires.Equal(pinned.ExpiresAt) {
		t.Fatalf("committed pin/issuance rows: clients=%d grants=%d matching=%d last=%s expiry=%s", clients, grants, matchingGrants, lastUsed, expires)
	}
}
