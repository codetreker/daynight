package oauth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgOAuth "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestOAuthAuthorizationMissingRelationsPreserveFailure(t *testing.T) {
	ctx := t.Context()
	db := isolatedStore(t)
	now := time.Now().UTC()
	record := authorizationRecord(now)
	// The capacity query must report the missing relation after acquiring its lock.
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `ALTER TABLE oauth_authorizations RENAME TO inaccessible_authorizations`); err != nil {
		t.Fatal(err)
	}
	ok, err := pgOAuth.NewDAO(tx).InsertAuthorization(ctx, record, 100, now)
	if ok || err == nil {
		t.Fatal("missing capacity table treated as empty")
	}
	if failed, state := store.DatabaseErrorFacts(err); !failed || state != "42P01" {
		t.Fatalf("missing table: failed=%t state=%s", failed, state)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	tx, err = db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `ALTER TABLE oauth_authorizations RENAME TO inaccessible_authorizations`); err != nil {
		t.Fatal(err)
	}
	_, err = pgOAuth.NewDAO(tx).ExpiredAuthorizations(ctx, now, 10)
	if failed, state := store.DatabaseErrorFacts(err); !failed || state != "42P01" {
		t.Fatalf("missing prune relation: failed=%t state=%s", failed, state)
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	err = pgOAuth.NewDAO(tx).LockAuthorizationCapacity(cancelled)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled prune lock: %v", err)
	}
}

func TestOAuthAuthorizationCapacityCancellation(t *testing.T) {
	ctx, stop := context.WithTimeout(t.Context(), 20*time.Second)
	defer stop()
	t.Run("cancellation while waiting for capacity", func(t *testing.T) {
		db := isolatedStore(t)
		holder, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer holder.Rollback(context.Background())
		if _, err = holder.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(0x444e4f4155544841)); err != nil {
			t.Fatal(err)
		}
		waitCtx, stop := context.WithCancel(ctx)
		defer stop()
		result := make(chan error, 1)
		go func() {
			_, err := db.WriteAuthorizations(waitCtx, func(scope store.AuthorizationScope) error {
				_, err := scope.AuthorizationDAO().InsertAuthorization(waitCtx, authorizationRecord(time.Now()), 100, time.Now())
				return err
			})
			result <- err
		}()
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			var waiting bool
			err := db.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid)))`, int32(holder.Conn().PgConn().PID())).Scan(&waiting)
			if err != nil {
				t.Fatal(err)
			}
			if waiting {
				break
			}
			select {
			case <-ctx.Done():
				t.Fatal("capacity lock wait not observed")
			case <-ticker.C:
			}
		}
		stop()
		select {
		case err := <-result:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation: %v", err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
		if err := holder.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM oauth_authorizations`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("cancelled insertion persisted: count=%d err=%v", count, err)
		}
	})
}

func TestAuthorizationCleanupFairAcrossOneRowBatches(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	now := time.Now().UTC()
	for range 4 {
		for _, status := range []string{"pending", "denied"} {
			retain := now.Add(time.Hour)
			if status == "denied" {
				retain = now.Add(-time.Hour)
			}
			_, err := db.Pool.Exec(ctx, `INSERT INTO oauth_authorizations (id,binding_hash,client_snapshot,client_id,redirect_uri,resource,scope,challenge,state,state_present,status,created_at,expires_at,retain_until) VALUES ($1,$2,'{}','client','https://client.test/callback','https://server.test/mcp','daynight:mcp','challenge','',false,$3,$4,$5,$6)`, uuid.NewString(), make([]byte, 32), status, now.Add(-2*time.Hour), now.Add(-time.Hour), retain)
			check(t, err)
		}
	}
	for batch := range 2 {
		tx, err := db.Pool.Begin(ctx)
		check(t, err)
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
			defer cancel()
			if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
				t.Error(err)
			}
		})
		dao := pgOAuth.NewDAO(tx)
		check(t, dao.LockAuthorizationCapacity(ctx))
		next, err := dao.AuthorizationCleanupCursor(ctx)
		check(t, err)
		if next != batch {
			t.Fatalf("persistent cleanup cursor: %d want %d", next, batch)
		}
		check(t, dao.SetAuthorizationCleanupCursor(ctx, (next+1)%2))
		if next == 0 {
			rows, err := dao.ExpiredAuthorizations(ctx, now, 1)
			check(t, err)
			if len(rows) != 1 {
				t.Fatalf("one-row expiration query: %d", len(rows))
			}
			rows[0].Status, rows[0].State, rows[0].StatePresent = "expired", "", false
			check(t, dao.UpdateAuthorization(ctx, rows[0]))
		} else {
			count, err := dao.DeleteRetainedAuthorizations(ctx, now, 1)
			check(t, err)
			if count != 1 {
				t.Fatalf("one-row retention delete: %d", count)
			}
		}
		check(t, tx.Commit(ctx))
	}
	var pending, expired, denied int
	check(t, db.Pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='pending'),count(*) FILTER (WHERE status='expired'),count(*) FILTER (WHERE status='denied') FROM oauth_authorizations`).Scan(&pending, &expired, &denied))
	if pending != 3 || expired != 1 || denied != 3 {
		t.Fatalf("unfair pruning: pending=%d expired=%d denied=%d", pending, expired, denied)
	}
}
