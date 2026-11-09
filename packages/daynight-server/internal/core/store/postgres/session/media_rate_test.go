package session_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
)

func sameStoredMediaRate(a, b store.SessionMediaRate) bool {
	return a.Tokens == b.Tokens && a.UpdatedAt.Equal(b.UpdatedAt)
}

func TestMediaRateStatePersistsIndependentOwnersAndCategories(t *testing.T) {
	db := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	initial := store.SessionMediaRate{Tokens: 8_000_000, UpdatedAt: now}
	replacement := store.SessionMediaRate{Tokens: 123_456, UpdatedAt: now.Add(time.Minute)}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		rate := d.(store.SessionMediaRateDAO)
		got, e := rate.LockSessionMediaRate(t.Context(), actor.UserID, "prepare", initial)
		if e != nil || !sameStoredMediaRate(got, initial) {
			t.Fatal(got, e)
		}
		return rate.SaveSessionMediaRate(t.Context(), actor.UserID, "prepare", replacement)
	})
	for _, key := range []struct{ owner, category string }{
		{actor.UserID, "prepare"}, {actor.UserID, "observe"}, {actor.UserID, "release"}, {actor.UserID, "control"}, {uuid.NewString(), "prepare"},
	} {
		sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
			rate := d.(store.SessionMediaRateDAO)
			changedSeed := store.SessionMediaRate{Tokens: 17, UpdatedAt: now.Add(24 * time.Hour)}
			got, e := rate.LockSessionMediaRate(t.Context(), key.owner, key.category, changedSeed)
			want := changedSeed
			if key.owner == actor.UserID && key.category == "prepare" {
				want = replacement
			}
			if e != nil || !sameStoredMediaRate(got, want) {
				t.Fatal("bucket was reseeded or mixed identities", key, got, want, e)
			}
			return nil
		})
	}
	var got store.SessionMediaRate
	if e := db.Pool.QueryRow(t.Context(), `SELECT tokens,updated_at FROM session_media_rates WHERE owner_user_id=$1 AND category='prepare'`, actor.UserID).Scan(&got.Tokens, &got.UpdatedAt); e != nil || !sameStoredMediaRate(got, replacement) {
		t.Fatal("independent persisted read differs", got, e)
	}
	tx, e := db.Pool.Begin(t.Context())
	if e != nil {
		t.Fatal(e)
	}
	rate := pgsession.New(tx).(store.SessionMediaRateDAO)
	if _, e = rate.LockSessionMediaRate(t.Context(), actor.UserID, "prepare", initial); e != nil {
		t.Fatal(e)
	}
	if e = rate.SaveSessionMediaRate(t.Context(), actor.UserID, "prepare", initial); e != nil {
		t.Fatal(e)
	}
	if e = tx.Rollback(t.Context()); e != nil {
		t.Fatal(e)
	}
	if e = db.Pool.QueryRow(t.Context(), `SELECT tokens,updated_at FROM session_media_rates WHERE owner_user_id=$1 AND category='prepare'`, actor.UserID).Scan(&got.Tokens, &got.UpdatedAt); e != nil || !sameStoredMediaRate(got, replacement) {
		t.Fatal("rolled-back state became persistent", got, e)
	}
}

func TestMediaRateConcurrentTransactionsSerializeOneAccountBucket(t *testing.T) {
	db := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	initial := store.SessionMediaRate{Tokens: 40_000_000, UpdatedAt: now}
	results := make(chan bool, 48)
	failures := make(chan error, 48)
	start := make(chan struct{})
	var group sync.WaitGroup
	for range 48 {
		group.Go(func() {
			<-start
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			tx, e := db.Pool.Begin(ctx)
			if e != nil {
				failures <- e
				return
			}
			defer tx.Rollback(context.Background())
			rate := pgsession.New(tx).(store.SessionMediaRateDAO)
			current, e := rate.LockSessionMediaRate(ctx, actor.UserID, "control", initial)
			if e != nil {
				failures <- e
				return
			}
			allowed := current.Tokens >= 1_000_000
			if allowed {
				current.Tokens -= 1_000_000
			}
			if e = rate.SaveSessionMediaRate(ctx, actor.UserID, "control", current); e != nil {
				failures <- e
				return
			}
			if e = tx.Commit(ctx); e != nil {
				failures <- e
				return
			}
			results <- allowed
		})
	}
	close(start)
	group.Wait()
	close(results)
	close(failures)
	for e := range failures {
		t.Fatal(e)
	}
	accepted := 0
	for allowed := range results {
		if allowed {
			accepted++
		}
	}
	if accepted != 40 {
		t.Fatalf("accepted %d concurrent replacements, want40", accepted)
	}
	var tokens int64
	if e := db.Pool.QueryRow(t.Context(), `SELECT tokens FROM session_media_rates WHERE owner_user_id=$1 AND category='control'`, actor.UserID).Scan(&tokens); e != nil || tokens != 0 {
		t.Fatal("committed deductions were lost", tokens, e)
	}
}

func TestMediaRateLockWaitPropagatesCancellationAndSaveRequiresExistingRow(t *testing.T) {
	db := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, db)
	initial := store.SessionMediaRate{Tokens: 8_000_000, UpdatedAt: time.Now().UTC().Truncate(time.Microsecond)}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		if e := d.(store.SessionMediaRateDAO).SaveSessionMediaRate(t.Context(), actor.UserID, "prepare", initial); !errors.Is(e, model.ErrNotFound) {
			t.Fatal("missing update reported success", e)
		}
		_, e := d.(store.SessionMediaRateDAO).LockSessionMediaRate(t.Context(), actor.UserID, "prepare", initial)
		return e
	})
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	first, e := db.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer first.Rollback(context.Background())
	if _, e = pgsession.New(first).(store.SessionMediaRateDAO).LockSessionMediaRate(ctx, actor.UserID, "prepare", initial); e != nil {
		t.Fatal(e)
	}
	second, e := db.Pool.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer second.Rollback(context.Background())
	query, cancelQuery := context.WithCancel(ctx)
	defer cancelQuery()
	done := make(chan error, 1)
	go func() {
		_, e := pgsession.New(second).(store.SessionMediaRateDAO).LockSessionMediaRate(query, actor.UserID, "prepare", initial)
		done <- e
	}()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	waiting := false
	for !waiting {
		if e = db.Pool.QueryRow(ctx, `SELECT COALESCE(wait_event_type='Lock',false) FROM pg_stat_activity WHERE pid=$1`, second.Conn().PgConn().PID()).Scan(&waiting); e != nil {
			t.Fatal(e)
		}
		if waiting {
			break
		}
		select {
		case e := <-done:
			t.Fatal("same account bucket did not wait for its current owner", e)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-ticker.C:
		}
	}
	cancelQuery()
	select {
	case e := <-done:
		if !errors.Is(e, context.Canceled) {
			t.Fatal("observed lock wait lost cancellation", e)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if e = second.Rollback(ctx); e != nil && !second.Conn().IsClosed() {
		t.Fatal(e)
	}
	if _, e = pgsession.New(second).(store.SessionMediaRateDAO).LockSessionMediaRate(ctx, actor.UserID, "prepare", initial); e == nil {
		t.Fatal("closed transaction admitted rate state")
	}
	if e = pgsession.New(second).(store.SessionMediaRateDAO).SaveSessionMediaRate(ctx, actor.UserID, "prepare", initial); e == nil {
		t.Fatal("closed transaction saved rate state")
	}
}
