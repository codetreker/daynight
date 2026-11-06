package postgres

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgOAuth "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

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
	n, err := core.PruneClients(ctx, db, 100, now)
	if err != nil || n != 1 {
		t.Fatalf("prune: %d %v", n, err)
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
		n   int
		err error
	}
	done := make(chan result, 1)
	go func() { n, err := core.PruneClients(ctx, db, 100, now); done <- result{n, err} }()
	// Wait until cleanup is blocked on the client row, before committing the grant.
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
	if got.err != nil || got.n != 0 {
		t.Fatalf("prune after issuance: %+v", got)
	}
	_, err = db.WriteOAuthClients(ctx, func(s store.OAuthClientScope) error {
		_, err := s.OAuthClientDAO().PinClient(ctx, "pinned", now)
		return err
	})
	if err != nil {
		t.Fatalf("referenced client removed: %v", err)
	}
}

func TestOAuthAdmissionConcurrentAndPersistent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	a := core.PublicAdmission{Writer: db, Now: func() time.Time { return now }}
	var wg sync.WaitGroup
	var mu sync.Mutex
	allowed := 0
	var failures []error
	for range 30 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			ok, err := a.Take(ctx, "register", "shared", "")
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				failures = append(failures, err)
			}
			if ok {
				allowed++
			}
		}()
	}
	wg.Wait()
	if len(failures) > 0 || allowed != 10 {
		t.Fatalf("allowed %d errors %v", allowed, failures)
	}
	// A new admission object observes the same persistent budget.
	again := core.PublicAdmission{Writer: db, Now: func() time.Time { return now }}
	if ok, err := again.Take(ctx, "register", "shared", ""); ok || err != nil {
		t.Fatalf("restart: %v %v", ok, err)
	}
	for i := 0; i < 69; i++ {
		if _, err := a.Take(ctx, "register", fmt.Sprintf("other-%d", i), ""); err != nil {
			t.Fatal(err)
		}
	}
	if ok, err := a.Take(ctx, "register", "new-source", ""); ok || err != nil {
		t.Fatalf("global budget: %v %v", ok, err)
	}
	again.Now = func() time.Time { return now.Add(time.Minute) }
	if ok, err := again.Take(ctx, "register", "shared", ""); !ok || err != nil {
		t.Fatalf("new window: %v %v", ok, err)
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

func TestOAuthTokenAdmissionTwoPhasesPersistent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC()
	a := core.PublicAdmission{Writer: db, Now: func() time.Time { return now }}
	for i := 0; i < 241; i++ {
		// New instances share persistent client counters without recharging source.
		if i%2 == 0 {
			a = core.PublicAdmission{Writer: db, Now: func() time.Time { return now }}
		}
		p, ok, err := a.TakeToken(ctx, fmt.Sprintf("source-%d", i/120))
		if !ok || err != nil {
			t.Fatalf("initial %d: %v %v", i, ok, err)
		}
		ok, err = p.TakeClient(ctx, "validated")
		if err != nil || ok != (i < 240) {
			t.Fatalf("client %d: %v %v", i, ok, err)
		}
	}
	var global, client int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT attempts FROM device_authorization_limits WHERE bucket_hash=$1), (SELECT attempts FROM device_authorization_limits WHERE bucket_hash=$2)`, secret.Hash("oauth:token:global"), secret.Hash("oauth:token:client:validated")).Scan(&global, &client); err != nil {
		t.Fatal(err)
	}
	if global != 241 || client != 241 {
		t.Fatalf("unexpected buckets global=%d client=%d", global, client)
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
