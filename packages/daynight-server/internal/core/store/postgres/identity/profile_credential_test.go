package identity_test

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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func profileCredentialDAO(tx pgx.Tx) store.IdentityDAO {
	return identity.NewScope(tx, oauth.NewDAO(tx)).IdentityDAO()
}

func TestProfileCredentialNativeKindsOwnerAndExpiry(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	user, session, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC()
	token := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash(uuid.NewString()), Name: "profile", CreatedAt: now}
	identityScopeTest(t, db, func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, token) })
	pat := model.Principal{Kind: model.PATCredential, UserID: user.ID, CredentialID: token.ID}
	for _, actor := range []model.Principal{session, pat} {
		identityScopeTest(t, db, func(scope store.IdentityScope) error {
			return scope.IdentityDAO().LockProfileCredential(ctx, actor, now)
		})
		wrong := actor
		wrong.UserID = uuid.NewString()
		_, err := db.WriteIdentity(ctx, func(scope store.IdentityScope) error {
			return scope.IdentityDAO().LockProfileCredential(ctx, wrong, now)
		})
		requireMissing(t, err)
	}
	for _, kind := range []model.CredentialKind{model.OAuthCredential, "unsupported"} {
		wrong := pat
		wrong.Kind = kind
		_, err := db.WriteIdentity(ctx, func(scope store.IdentityScope) error {
			return scope.IdentityDAO().LockProfileCredential(ctx, wrong, now)
		})
		requireMissing(t, err)
	}
	expiry := now.Add(time.Hour)
	identityScopeTest(t, db, func(scope store.IdentityScope) error {
		_, err := scope.IdentityDAO().SetPATExpiry(ctx, pat.CredentialID, &expiry)
		return err
	})
	_, err := db.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		return scope.IdentityDAO().LockProfileCredential(ctx, pat, expiry)
	})
	requireMissing(t, err)
	identityScopeTest(t, db, func(scope store.IdentityScope) error {
		return scope.IdentityDAO().DeletePAT(ctx, user.ID, pat.CredentialID)
	})
	_, err = db.WriteIdentity(ctx, func(scope store.IdentityScope) error { return scope.IdentityDAO().LockProfileCredential(ctx, pat, now) })
	requireMissing(t, err)
	identityScopeTest(t, db, func(scope store.IdentityScope) error { return scope.IdentityDAO().DeleteSession(ctx, session) })
	_, err = db.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		return scope.IdentityDAO().LockProfileCredential(ctx, session, now)
	})
	requireMissing(t, err)
}

func TestProfileCredentialSharesReadersAndBlocksNativeMutation(t *testing.T) {
	db := isolatedStore(t)
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential} {
		for _, mutation := range []string{"revoke", "expiry"} {
			if !t.Run(string(kind)+"/"+mutation, func(t *testing.T) {
				testProfileCredentialMutation(t, db, kind, mutation)
			}) {
				return
			}
			testutil.AssertPoolReusable(t, db.Pool)
		}
	}
}

func testProfileCredentialMutation(t *testing.T, db *postgres.Store, kind model.CredentialKind, mutation string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()

	user, actor, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC()
	table := "sessions"
	if kind == model.PATCredential {
		table = "personal_access_tokens"
		actor = model.Principal{Kind: kind, UserID: user.ID, CredentialID: uuid.NewString()}
		identityScopeTest(t, db, func(scope store.IdentityScope) error {
			return scope.IdentityDAO().InsertPAT(ctx, model.PersonalAccessToken{ID: actor.CredentialID, UserID: user.ID, TokenHash: hash(uuid.NewString()), Name: "profile", CreatedAt: now})
		})
	}
	statement := `DELETE FROM ` + table + ` WHERE id=$1`
	if mutation == "expiry" {
		statement = `UPDATE ` + table + ` SET expires_at=clock_timestamp() WHERE id=$1`
	}

	holder, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	var writerTask sync.WaitGroup
	holderCommitAttempted := false
	defer func() {
		cancel()
		if !holderCommitAttempted {
			rollbackProfileCredentialTransaction(t, ctx, holder)
		}
		writerTask.Wait()
	}()
	holderPID := holder.Conn().PgConn().PID()
	requireNoError(t, profileCredentialDAO(holder).LockProfileCredential(ctx, actor, now))
	checkCompatibleProfileCredentialReader(t, ctx, db, actor, now)

	ready := make(chan uint32, 1)
	result := make(chan error, 1)
	writerTask.Go(func() {
		writer, err := db.Pool.Begin(ctx)
		if err != nil {
			result <- err
			return
		}
		commitAttempted := false
		defer func() {
			if !commitAttempted {
				rollbackProfileCredentialTransaction(t, ctx, writer)
			}
		}()
		ready <- writer.Conn().PgConn().PID()
		tag, err := writer.Exec(ctx, statement, actor.CredentialID)
		if err != nil {
			result <- err
			return
		}
		if tag.RowsAffected() != 1 {
			result <- fmt.Errorf("credential mutation affected %d rows", tag.RowsAffected())
			return
		}
		commitAttempted = true
		result <- writer.Commit(ctx)
	})

	var writerPID uint32
	select {
	case writerPID = <-ready:
	case err := <-result:
		t.Fatalf("credential writer finished without observing the lock: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	waitProfileCredentialLock(t, ctx, db, statement, writerPID, holderPID, result)
	holderCommitAttempted = true
	requireNoError(t, holder.Commit(ctx))
	requireNoError(t, testutil.ReceiveQueryResult(t, ctx, result))

	completion, err := db.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		return scope.IdentityDAO().LockProfileCredential(ctx, actor, now)
	})
	requireMissing(t, err)
	if completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("missing credential completed with %q", completion.Outcome)
	}
}

func checkCompatibleProfileCredentialReader(t *testing.T, ctx context.Context, db *postgres.Store, actor model.Principal, now time.Time) {
	t.Helper()
	reader, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer rollbackProfileCredentialTransaction(t, ctx, reader)
	requireNoError(t, profileCredentialDAO(reader).LockProfileCredential(ctx, actor, now))
}

func TestProfileCredentialExpiryIsRecheckedAfterCredentialRowWait(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.SessionCredential, model.PATCredential} {
		t.Run(string(kind), func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			user, actor, _ := testutil.AuthRecords(t, db)
			now := time.Now().UTC()
			table := "sessions"
			if kind == model.PATCredential {
				table = "personal_access_tokens"
				actor = model.Principal{Kind: kind, UserID: user.ID, CredentialID: uuid.NewString()}
				identityScopeTest(t, db, func(scope store.IdentityScope) error {
					return scope.IdentityDAO().InsertPAT(ctx, model.PersonalAccessToken{ID: actor.CredentialID, UserID: user.ID, TokenHash: hash(uuid.NewString()), Name: "profile", CreatedAt: now})
				})
			}
			expires := testutil.ArmCredentialExpiry(t, ctx, db.Pool, table, actor.CredentialID, 3)
			if !now.Before(expires) {
				t.Fatalf("caller time %v must precede credential expiry %v", now, expires)
			}
			holder, err := db.Pool.Begin(ctx)
			requireNoError(t, err)
			var readerTask sync.WaitGroup
			holderCommitAttempted := false
			defer func() {
				cancel()
				if !holderCommitAttempted {
					rollbackProfileCredentialTransaction(t, ctx, holder)
				}
				readerTask.Wait()
			}()
			// Updating the locked tuple could cause the initial lookup to recheck its own predicate.
			var lockedExpiry time.Time
			requireNoError(t, holder.QueryRow(ctx, `SELECT expires_at FROM `+table+` WHERE id=$1 AND user_id=$2 FOR UPDATE`,
				actor.CredentialID, actor.UserID).Scan(&lockedExpiry))
			if !lockedExpiry.Equal(expires) {
				t.Fatalf("locked credential expiry = %v, want %v", lockedExpiry, expires)
			}
			holderPID := holder.Conn().PgConn().PID()

			ready := make(chan uint32, 1)
			result := make(chan error, 1)
			readerTask.Go(func() {
				reader, err := db.Pool.Begin(ctx)
				if err != nil {
					result <- err
					return
				}
				defer rollbackProfileCredentialTransaction(t, ctx, reader)
				ready <- reader.Conn().PgConn().PID()
				result <- profileCredentialDAO(reader).LockProfileCredential(ctx, actor, now)
			})
			var readerPID uint32
			select {
			case readerPID = <-ready:
			case err := <-result:
				t.Fatalf("credential reader finished without observing the lock: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}

			predicate := "expires_at > clock_timestamp()"
			columns := "expires_at"
			if kind == model.PATCredential {
				predicate = "(expires_at IS NULL OR expires_at > clock_timestamp())"
				columns += ", business_scopes, scope_version"
			}
			statement := "SELECT " + columns + " FROM " + table + " WHERE id=$1 AND user_id=$2 AND " + predicate + " FOR SHARE"
			waitProfileCredentialLock(t, ctx, db, statement, readerPID, holderPID, result)
			testutil.WaitForCredentialExpiry(t, ctx, db.Pool, expires)
			holderCommitAttempted = true
			requireNoError(t, holder.Commit(ctx))
			err = testutil.ReceiveQueryResult(t, ctx, result)
			requireMissing(t, err)
			if errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("initial credential lookup returned no row: %v", err)
			}
		})
	}
}

func waitProfileCredentialLock(t *testing.T, ctx context.Context, db *postgres.Store, statement string, waiterPID, holderPID uint32, result <-chan error) {
	t.Helper()
	for {
		select {
		case err := <-result:
			t.Fatalf("credential operation %q finished without observing the lock: %v", statement, err)
		default:
		}
		var waiting bool
		requireNoError(t, db.Pool.QueryRow(ctx, `SELECT EXISTS (
			SELECT FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND query=$2
				AND $3=ANY(pg_blocking_pids(pid))
		)`, waiterPID, statement, holderPID).Scan(&waiting))
		if waiting {
			return
		}
		if err := testutil.WaitThreadClock(ctx); err != nil {
			t.Fatalf("credential operation %q on backend %d did not wait for holder %d: %v", statement, waiterPID, holderPID, err)
		}
	}
}

func rollbackProfileCredentialTransaction(t *testing.T, operationCtx context.Context, tx pgx.Tx) {
	t.Helper()
	cleanup, cancel := context.WithTimeout(context.WithoutCancel(operationCtx), 5*time.Second)
	defer cancel()

	// Rollback returns the connection to the pool. Retain the cleanup signal while we own it.
	conn := tx.Conn().PgConn()
	closedBefore, cleanupDone := conn.IsClosed(), conn.CleanupDone()
	err := tx.Rollback(cleanup)
	if err == nil || errors.Is(err, pgx.ErrTxClosed) {
		return
	}
	if errors.Is(err, pgconn.ErrConnClosed) && (closedBefore || operationCtx.Err() != nil) {
		select {
		case <-cleanupDone:
			return
		case <-cleanup.Done():
			err = errors.Join(err, cleanup.Err())
		}
	}
	t.Errorf("rollback profile credential transaction: %v", err)
}
