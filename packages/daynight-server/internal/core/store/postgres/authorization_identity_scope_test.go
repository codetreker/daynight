package postgres

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type authorizationReceiverResult struct {
	completion store.Completion
	err        error
}

func authorizationReceiverAwaitBlock(t *testing.T, ctx context.Context, database *Store, blocker uint32, result <-chan authorizationReceiverResult) {
	t.Helper()
	for {
		var blocked bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM pg_stat_activity
 WHERE application_name=current_schema() AND wait_event_type='Lock' AND $1::integer=ANY(pg_blocking_pids(pid)))`, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			return
		}
		select {
		case got := <-result:
			t.Fatalf("authorization scope completed before row wait: %+v, %v", got.completion, got.err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func authorizationReceiverDrain(t *testing.T, cancel context.CancelFunc, holder pgx.Tx, done <-chan struct{}) {
	t.Helper()
	cancel()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if err := holder.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Errorf("release authorization scope blocker: %v", err)
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Error("authorization scope worker did not stop after cancellation and blocker release")
	}
}

func TestAuthorizationScopeSessionChangesAcrossLockWait(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, name := range []string{"revoked session", "expired after request wait"} {
		t.Run(name, func(t *testing.T) {
			f := newAuthorizationReceiverFixture(t, "session-recheck-client", "pending")
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			session := model.Session{ID: uuid.NewString(), UserID: f.issue.Grant.UserID, TokenHash: secret.Hash("receiver-session"), CreatedAt: f.now, ExpiresAt: f.now.Add(time.Hour)}
			principal := model.Principal{Kind: model.SessionCredential, UserID: session.UserID, CredentialID: session.ID}
			completion, err := f.database.WriteIdentity(ctx, func(scope store.IdentityScope) error {
				return scope.IdentityDAO().InsertSession(ctx, session)
			})
			authorizationReceiverCommitted(t, completion, err)
			before := authorizationReceiverRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID)
			holder, err := f.database.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				cleanup, stop := context.WithTimeout(context.Background(), 5*time.Second)
				defer stop()
				if err := holder.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
					t.Errorf("rollback authorization scope holder: %v", err)
				}
			}()
			if name == "revoked session" {
				if _, err := holder.Exec(ctx, "DELETE FROM sessions WHERE id=$1", session.ID); err != nil {
					t.Fatal(err)
				}
			} else {
				var locked string
				if err := holder.QueryRow(ctx, "SELECT id::text FROM oauth_authorizations WHERE id=$1 FOR UPDATE", f.authorization.ID).Scan(&locked); err != nil || locked != f.authorization.ID {
					t.Fatalf("lock authorization: %s, %v", locked, err)
				}
			}
			advanced := make(chan time.Time, 1)
			result, done := make(chan authorizationReceiverResult, 1), make(chan struct{})
			go func() {
				defer close(done)
				completion, err := f.database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
					if err := scope.IdentityDAO().LockSession(ctx, principal, f.now); err != nil {
						return err
					}
					if name == "revoked session" {
						return errors.New("deleted session remained lockable")
					}
					if _, err := scope.AuthorizationDAO().Authorization(ctx, f.authorization.ID, true); err != nil {
						return err
					}
					var callerNow time.Time
					select {
					case callerNow = <-advanced:
					case <-ctx.Done():
						return ctx.Err()
					}
					fresh, err := scope.AuthorizationDAO().FreshTime(ctx, callerNow)
					if err != nil {
						return err
					}
					if fresh.Before(callerNow) {
						return fmt.Errorf("fresh authorization clock %s precedes caller clock %s", fresh, callerNow)
					}
					return scope.IdentityDAO().LockSession(ctx, principal, fresh)
				})
				result <- authorizationReceiverResult{completion: completion, err: err}
			}()
			defer authorizationReceiverDrain(t, cancel, holder, done)
			authorizationReceiverAwaitBlock(t, ctx, f.database, holder.Conn().PgConn().PID(), result)
			if name == "expired after request wait" {
				advanced <- f.now.Add(2 * time.Hour)
			}
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case got := <-result:
				if got.completion.Outcome != store.TransactionNotCommitted || !errors.Is(got.err, model.ErrNotFound) {
					t.Fatalf("session recheck completion=%+v, error=%v", got.completion, got.err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			authorizationReceiverAssertRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID, before)
			if got := authorizationReceiverCounts(t, ctx, f.database); got != ([3]int64{}) {
				t.Fatalf("failed session recheck issued family rows: %v", got)
			}
			var sessions int
			if err := f.database.Pool.QueryRow(ctx, "SELECT count(*) FROM sessions WHERE id=$1", session.ID).Scan(&sessions); err != nil {
				t.Fatal(err)
			}
			want := 1
			if name == "revoked session" {
				want = 0
			}
			if sessions != want {
				t.Fatalf("session persistence after wait: got %d, want %d", sessions, want)
			}
		})
	}
}
