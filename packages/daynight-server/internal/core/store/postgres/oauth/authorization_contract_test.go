package oauth_test

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgOAuth "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
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

type oauthReceiverResult[T any] struct {
	value T
	err   error
}

func startOAuthReceiverTransaction[T any](ctx context.Context, conn *pgxpool.Conn, work func(pgx.Tx) (T, error)) (<-chan oauthReceiverResult[T], <-chan struct{}) {
	result, done := make(chan oauthReceiverResult[T], 1), make(chan struct{})
	go func() {
		defer close(done)
		result <- func() (out oauthReceiverResult[T]) {
			defer conn.Release()
			tx, err := conn.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
			if err != nil {
				out.err = err
				return out
			}
			defer func() {
				cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
					out.err = errors.Join(out.err, err)
				}
			}()
			out.value, out.err = work(tx)
			if out.err == nil {
				out.err = tx.Commit(ctx)
			}
			return out
		}()
	}()
	return result, done
}

func awaitOAuthReceiverLock(t *testing.T, ctx context.Context, pool *pgxpool.Pool, blocker, waiter uint32, done <-chan struct{}) {
	t.Helper()
	for {
		var blocked bool
		check(t, pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2))`, blocker, waiter).Scan(&blocked))
		if blocked {
			return
		}
		select {
		case <-done:
			t.Fatal("OAuth receiver completed before the expected lock wait")
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func drainOAuthReceiverTransaction(t *testing.T, cancel context.CancelFunc, blocker pgx.Tx, socket net.Conn, done <-chan struct{}) {
	t.Helper()
	cancel()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if err := blocker.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Errorf("release OAuth receiver blocker: %v", err)
	}
	select {
	case <-done:
		return
	case <-ctx.Done():
		t.Error("OAuth receiver transaction did not exit after cancellation")
	}
	// The worker owns pgx; the underlying socket supports concurrent interruption.
	if err := socket.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
		t.Errorf("interrupt OAuth receiver socket: %v", err)
	}
	forced, stopForced := context.WithTimeout(context.Background(), 3*time.Second)
	defer stopForced()
	select {
	case <-done:
	case <-forced.Done():
		t.Error("OAuth receiver transaction remained active after socket interruption")
	}
}

func TestAuthorizationCapacityWaitSamplesFreshTime(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	holder, err := db.Pool.Begin(ctx)
	check(t, err)
	defer holder.Rollback(context.Background())
	_, err = holder.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(0x444e4f4155544841))
	check(t, err)
	stale := time.Now().UTC().Truncate(time.Microsecond).Add(-time.Hour)
	record := store.OAuthAuthorization{ID: uuid.NewString(), BindingHash: make([]byte, 32), Client: []byte(`{}`), ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Scope: "daynight:mcp", Challenge: "challenge", Status: "pending", CreatedAt: stale, ExpiresAt: stale.Add(10 * time.Minute), RetainUntil: stale.Add(24 * time.Hour)}
	conn, err := db.Pool.Acquire(ctx)
	check(t, err)
	pid, socket := conn.Conn().PgConn().PID(), conn.Conn().PgConn().Conn()
	workerCtx, stop := context.WithCancel(ctx)
	result, done := startOAuthReceiverTransaction(workerCtx, conn, func(tx pgx.Tx) (bool, error) {
		return pgOAuth.NewDAO(tx).InsertAuthorization(workerCtx, record, 1, stale)
	})
	defer drainOAuthReceiverTransaction(t, stop, holder, socket, done)
	awaitOAuthReceiverLock(t, ctx, db.Pool, holder.Conn().PgConn().PID(), pid, done)
	var releaseLowerBound time.Time
	check(t, holder.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&releaseLowerBound))
	check(t, holder.Commit(ctx))
	select {
	case out := <-result:
		if out.err != nil || !out.value {
			t.Fatalf("capacity insertion after lock: inserted=%t error=%v", out.value, out.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var created, expires, retain time.Time
	check(t, db.Pool.QueryRow(ctx, `SELECT created_at,expires_at,retain_until FROM oauth_authorizations WHERE id=$1`, record.ID).Scan(&created, &expires, &retain))
	if created.Before(releaseLowerBound) || expires.Sub(created) != 10*time.Minute || retain.Sub(created) != 24*time.Hour {
		t.Fatalf("fresh capacity timestamps: created=%s release=%s expires=%s retain=%s", created, releaseLowerBound, expires, retain)
	}
	overflow := record
	overflow.ID = uuid.NewString()
	tx, err := db.Pool.Begin(ctx)
	check(t, err)
	defer tx.Rollback(context.Background())
	inserted, err := pgOAuth.NewDAO(tx).InsertAuthorization(ctx, overflow, 1, stale)
	check(t, err)
	if inserted {
		t.Fatal("second pending authorization exceeded limit one")
	}
	check(t, tx.Commit(ctx))
	var count, overflowCount int
	check(t, db.Pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER(WHERE id=$1) FROM oauth_authorizations`, overflow.ID).Scan(&count, &overflowCount))
	if count != 1 || overflowCount != 0 {
		t.Fatalf("capacity persistence: total=%d overflow=%d", count, overflowCount)
	}
}

func TestAuthorizationCodeLockReadsCommittedExpiry(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	now := time.Now().UTC().Truncate(time.Microsecond)
	record := authorizationRecord(now)
	tx, err := db.Pool.Begin(ctx)
	check(t, err)
	defer tx.Rollback(context.Background())
	inserted, err := pgOAuth.NewDAO(tx).InsertAuthorization(ctx, record, 10, now)
	check(t, err)
	if !inserted {
		t.Fatal("fixture authorization was not inserted")
	}
	initialExpiry := now.Add(time.Minute)
	record.Status, record.UserID, record.CodeHash, record.CodeExpiresAt = "approved", uuid.NewString(), digest("lock-expiry-code"), &initialExpiry
	check(t, pgOAuth.NewDAO(tx).UpdateAuthorization(ctx, record))
	check(t, tx.Commit(ctx))
	holder, err := db.Pool.Begin(ctx)
	check(t, err)
	defer holder.Rollback(context.Background())
	var expired time.Time
	check(t, holder.QueryRow(ctx, `UPDATE oauth_authorizations SET code_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1 RETURNING code_expires_at`, record.ID).Scan(&expired))
	conn, err := db.Pool.Acquire(ctx)
	check(t, err)
	pid, socket := conn.Conn().PgConn().PID(), conn.Conn().PgConn().Conn()
	workerCtx, stop := context.WithCancel(ctx)
	type observation struct {
		record store.OAuthAuthorization
		fresh  time.Time
	}
	result, done := startOAuthReceiverTransaction(workerCtx, conn, func(tx pgx.Tx) (observation, error) {
		dao := pgOAuth.NewDAO(tx)
		row, err := dao.AuthorizationByCode(workerCtx, record.CodeHash, true)
		if err != nil {
			return observation{}, err
		}
		fresh, err := dao.FreshTime(workerCtx, now)
		return observation{row, fresh}, err
	})
	defer drainOAuthReceiverTransaction(t, stop, holder, socket, done)
	awaitOAuthReceiverLock(t, ctx, db.Pool, holder.Conn().PgConn().PID(), pid, done)
	var releaseLowerBound time.Time
	check(t, holder.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&releaseLowerBound))
	check(t, holder.Commit(ctx))
	select {
	case out := <-result:
		if out.err != nil || out.value.record.ID != record.ID || out.value.record.Status != "approved" || out.value.record.CodeExpiresAt == nil || !out.value.record.CodeExpiresAt.Equal(expired) || out.value.fresh.Before(releaseLowerBound) {
			t.Fatalf("committed code expiry after lock: %+v error=%v release=%s", out.value, out.err, releaseLowerBound)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var status string
	var persistedExpiry time.Time
	var grants, access, refresh int
	check(t, db.Pool.QueryRow(ctx, `SELECT status,code_expires_at,(SELECT count(*) FROM oauth_grants),(SELECT count(*) FROM oauth_access_tokens),(SELECT count(*) FROM oauth_refresh_tokens) FROM oauth_authorizations WHERE id=$1`, record.ID).Scan(&status, &persistedExpiry, &grants, &access, &refresh))
	if status != "approved" || !persistedExpiry.Equal(expired) || grants != 0 || access != 0 || refresh != 0 {
		t.Fatalf("expiry persistence: status=%s expiry=%s family=%d/%d/%d", status, persistedExpiry, grants, access, refresh)
	}
}

func TestAuthorizationRetentionCommitsExpiryAndDeletesTwoRows(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	now := time.Now().UTC().Truncate(time.Microsecond)
	approved, pending := authorizationRecord(now), authorizationRecord(now)
	tx, err := db.Pool.Begin(ctx)
	check(t, err)
	defer tx.Rollback(context.Background())
	dao := pgOAuth.NewDAO(tx)
	for _, record := range []store.OAuthAuthorization{approved, pending} {
		inserted, err := dao.InsertAuthorization(ctx, record, 10, now)
		check(t, err)
		if !inserted {
			t.Fatal("retention fixture authorization was not inserted")
		}
	}
	expiredCode := now.Add(-time.Second)
	approved.Status, approved.UserID, approved.State, approved.StatePresent = "approved", uuid.NewString(), "", false
	approved.CodeHash, approved.CodeExpiresAt = digest("retained-approved-code"), &expiredCode
	check(t, dao.UpdateAuthorization(ctx, approved))
	_, err = tx.Exec(ctx, `UPDATE oauth_authorizations SET expires_at=$2 WHERE id=$1`, pending.ID, now.Add(-time.Second))
	check(t, err)
	check(t, tx.Commit(ctx))

	tx, err = db.Pool.Begin(ctx)
	check(t, err)
	defer tx.Rollback(context.Background())
	dao = pgOAuth.NewDAO(tx)
	rows, err := dao.ExpiredAuthorizations(ctx, now, 100)
	check(t, err)
	if len(rows) != 1 || rows[0].ID != pending.ID {
		t.Fatalf("expired pending selection: %+v", rows)
	}
	rows[0].Status, rows[0].State, rows[0].StatePresent = "expired", "", false
	check(t, dao.UpdateAuthorization(ctx, rows[0]))
	check(t, tx.Commit(ctx))
	var status, state string
	var present bool
	check(t, db.Pool.QueryRow(ctx, `SELECT status,state,state_present FROM oauth_authorizations WHERE id=$1`, pending.ID).Scan(&status, &state, &present))
	if status != "expired" || state != "" || present {
		t.Fatalf("expired authorization was not scrubbed: %s %q %t", status, state, present)
	}
	var codeExpiry time.Time
	check(t, db.Pool.QueryRow(ctx, `SELECT status,code_expires_at FROM oauth_authorizations WHERE id=$1`, approved.ID).Scan(&status, &codeExpiry))
	if status != "approved" || !codeExpiry.Equal(expiredCode) {
		t.Fatalf("approved code expiry changed during pending cleanup: %s %s", status, codeExpiry)
	}
	_, err = db.Pool.Exec(ctx, `UPDATE oauth_authorizations SET retain_until=$2 WHERE id=ANY($1::uuid[])`, []string{approved.ID, pending.ID}, now.Add(-time.Second))
	check(t, err)
	tx, err = db.Pool.Begin(ctx)
	check(t, err)
	defer tx.Rollback(context.Background())
	removed, err := pgOAuth.NewDAO(tx).DeleteRetainedAuthorizations(ctx, now, 100)
	check(t, err)
	if removed != 2 {
		t.Fatalf("retained authorization delete count=%d, want two", removed)
	}
	check(t, tx.Commit(ctx))
	var count int
	check(t, db.Pool.QueryRow(ctx, `SELECT count(*) FROM oauth_authorizations WHERE id=ANY($1::uuid[])`, []string{approved.ID, pending.ID}).Scan(&count))
	if count != 0 {
		t.Fatalf("retained original authorizations remain: %d", count)
	}
}
