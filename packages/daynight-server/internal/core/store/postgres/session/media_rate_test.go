package session_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
)

func TestMediaRateAdmissionPersistsRefillAndIndependentObservation(t *testing.T) {
	db := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	take := func(category string, at time.Time, rate, burst int) bool {
		t.Helper()
		var allowed bool
		sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
			var e error
			allowed, e = d.(store.SessionMediaRateDAO).TakeSessionMediaRate(t.Context(), actor.UserID, category, at, rate, burst)
			return e
		})
		return allowed
	}
	for i := 0; i < 8; i++ {
		if !take("prepare", now, 2, 8) {
			t.Fatal("burst rejected", i)
		}
	}
	if take("prepare", now, 2, 8) || take("prepare", now.Add(499999*time.Microsecond), 2, 8) {
		t.Fatal("rate overbooked")
	}
	if !take("prepare", now.Add(500000*time.Microsecond), 2, 8) {
		t.Fatal("exact refill rejected")
	}
	if take("prepare", now.Add(-time.Hour), 2, 8) {
		t.Fatal("clock rollback minted tokens")
	}
	if !take("observe", now, 20, 40) || !take("release", now, 20, 40) || !take("control", now, 20, 40) {
		t.Fatal("input exhaustion blocked independent reconciliation")
	}
	if !take("prepare", now.AddDate(20, 0, 0), 2, 8) {
		t.Fatal("large clock advance failed")
	}
	sessionDAOTransaction(t, db, func(d store.SessionDAO) error {
		_, e := d.(store.SessionMediaRateDAO).TakeSessionMediaRate(t.Context(), actor.UserID, "invalid", now, 2, 8)
		if e == nil {
			t.Fatal("invalid policy accepted")
		}
		return nil
	})
}

func TestMediaRateConcurrentTransactionsShareOneAccountBurst(t *testing.T) {
	db := isolatedStore(t)
	_, actor, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	results := make(chan bool, 48)
	failures := make(chan error, 48)
	var group sync.WaitGroup
	for i := 0; i < 48; i++ {
		group.Go(func() {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			tx, e := db.Pool.Begin(ctx)
			if e != nil {
				failures <- e
				return
			}
			defer tx.Rollback(context.Background())
			allowed, e := pgsession.New(tx).(store.SessionMediaRateDAO).TakeSessionMediaRate(ctx, actor.UserID, "control", now, 20, 40)
			if e != nil {
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
		t.Fatalf("accepted %d concurrent mutations, want40", accepted)
	}
}
