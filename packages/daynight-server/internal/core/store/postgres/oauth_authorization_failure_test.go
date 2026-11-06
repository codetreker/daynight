package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgOAuth "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/google/uuid"
)

func authorizationFailureRecord(now time.Time) store.OAuthAuthorization {
	return store.OAuthAuthorization{ID: uuid.NewString(), BindingHash: make([]byte, 32), Client: []byte(`{}`), ClientID: "client", RedirectURI: "https://client.test/callback", Resource: "https://server.test/mcp", Scope: "daynight:mcp", Challenge: "challenge", State: "state", StatePresent: true, Status: "pending", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(24 * time.Hour)}
}

func TestOAuthAuthorizationDAOFailurePaths(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	t.Run("insert query and constraint failures", func(t *testing.T) {
		db := isolatedStore(t)
		now := time.Now().UTC()
		record := authorizationFailureRecord(now)
		// A missing relation after taking the capacity lock is a database failure,
		// not an empty capacity result. The enclosing transaction rolls back.
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
		record.BindingHash = []byte{1}
		completion, err := db.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
			inserted, err := scope.AuthorizationDAO().InsertAuthorization(ctx, record, 100, now)
			if inserted {
				t.Error("invalid binding inserted")
			}
			return err
		})
		if err == nil || completion.Outcome != store.TransactionNotCommitted {
			t.Fatalf("constraint result: %+v %v", completion, err)
		}
		if failed, state := store.DatabaseErrorFacts(err); !failed || state != "23514" {
			t.Fatalf("constraint: failed=%t state=%s", failed, state)
		}
		var count int
		if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM oauth_authorizations`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("failed insertion persisted: count=%d err=%v", count, err)
		}
	})
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
				_, err := scope.AuthorizationDAO().InsertAuthorization(waitCtx, authorizationFailureRecord(time.Now()), 100, time.Now())
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
	t.Run("prune failure rolls back expired states", func(t *testing.T) {
		db := isolatedStore(t)
		now := time.Now().UTC()
		pending, expired := uuid.NewString(), uuid.NewString()
		_, err := db.Pool.Exec(ctx, `INSERT INTO oauth_authorizations (id,binding_hash,client_snapshot,client_id,redirect_uri,resource,scope,challenge,state,state_present,status,created_at,expires_at,retain_until) VALUES
            ($1,$3,'{}','client','https://client.test/callback','https://server.test/mcp','daynight:mcp','challenge','state',true,'pending',$4,$5,$6),
            ($2,$3,'{}','client','https://client.test/callback','https://server.test/mcp','daynight:mcp','challenge','',false,'denied',$4,$5,$5)`, pending, expired, make([]byte, 32), now.Add(-time.Hour), now.Add(-time.Minute), now.Add(time.Hour))
		if err != nil {
			t.Fatal(err)
		}
		_, err = db.Pool.Exec(ctx, `CREATE FUNCTION reject_oauth_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture delete failure'; END $$; CREATE TRIGGER reject_oauth_delete BEFORE DELETE ON oauth_authorizations FOR EACH ROW EXECUTE FUNCTION reject_oauth_delete()`)
		if err != nil {
			t.Fatal(err)
		}
		completion, err := db.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
			_, err := scope.AuthorizationDAO().PruneAuthorizations(ctx, now, 10)
			return err
		})
		if err == nil || completion.Outcome != store.TransactionNotCommitted {
			t.Fatalf("prune result: %+v %v", completion, err)
		}
		if failed, state := store.DatabaseErrorFacts(err); !failed || state != "P0001" {
			t.Fatalf("delete: failed=%t state=%s", failed, state)
		}
		var status, state string
		var present bool
		if err = db.Pool.QueryRow(ctx, `SELECT status,state,state_present FROM oauth_authorizations WHERE id=$1`, pending).Scan(&status, &state, &present); err != nil || status != "pending" || state != "state" || !present {
			t.Fatalf("failed prune partially committed: %s %t %v", status, present, err)
		}
		// An unavailable table also fails the first prune statement explicitly.
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = tx.Exec(ctx, `ALTER TABLE oauth_authorizations RENAME TO inaccessible_authorizations`); err != nil {
			t.Fatal(err)
		}
		_, err = pgOAuth.NewDAO(tx).PruneAuthorizations(ctx, now, 10)
		if failed, state := store.DatabaseErrorFacts(err); !failed || state != "42P01" {
			t.Fatalf("missing table: failed=%t state=%s", failed, state)
		}
		if err = tx.Rollback(ctx); err != nil {
			t.Fatal(err)
		}
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		tx, err = db.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		_, err = pgOAuth.NewDAO(tx).PruneAuthorizations(cancelled, now, 10)
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled prune: %v", err)
		}
		_ = tx.Rollback(ctx)
	})
}
