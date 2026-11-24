package postgres

import (
	"bytes"
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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAuthorizationScopeCommitsAndRollsBackAllDAOsTogether(t *testing.T) {
	parallelRootDatabaseTest(t)
	for _, commit := range []bool{true, false} {
		t.Run(fmt.Sprintf("commit=%t", commit), func(t *testing.T) {
			database := isolatedStore(t)
			ctx := t.Context()
			now := time.Now().UTC().Truncate(time.Microsecond)
			user := model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}
			client := store.OAuthClient{ID: "scope-client", Metadata: []byte(`{"client_name":"Scope client"}`), CreatedAt: now, LastUsedAt: now, ExpiresAt: now.Add(24 * time.Hour)}
			issue := store.OAuthFamilyIssue{
				Grant:    store.OAuthGrant{ID: uuid.NewString(), UserID: user.ID, ClientID: client.ID, Resource: "https://server.test/mcp", Scope: "daynight:mcp", ClientSnapshot: client.Metadata, CreatedAt: now, ExpiresAt: now.Add(24 * time.Hour)},
				AccessID: uuid.NewString(), AccessHash: bytes.Repeat([]byte{1}, 32), RefreshHash: bytes.Repeat([]byte{2}, 32), AccessExpiresAt: now.Add(time.Hour),
			}
			authorization := authorizationFailureRecord(now)
			refusal := errors.New("reject composed authorization")
			completion, err := database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
				persisted, err := scope.IdentityDAO().UpsertUser(ctx, user, now)
				if err != nil {
					return err
				}
				if persisted.ID != user.ID || persisted.UniAuthID != user.UniAuthID {
					return fmt.Errorf("identity DAO returned wrong user: %+v", persisted)
				}
				inserted, err := scope.OAuthClientDAO().InsertClient(ctx, client, 10, now)
				if err != nil {
					return err
				}
				if !inserted {
					return errors.New("client DAO rejected available capacity")
				}
				if err := scope.CredentialFamilyDAO().IssueFamily(ctx, issue); err != nil {
					return err
				}
				identity, err := scope.CredentialFamilyDAO().AuthenticateAccess(ctx, issue.AccessHash, []store.OAuthBinding{{Resource: issue.Grant.Resource, Scope: issue.Grant.Scope}}, now)
				if err != nil {
					return err
				}
				if identity.GrantID != issue.Grant.ID || identity.Principal.UserID != user.ID || identity.Principal.CredentialID != issue.AccessID {
					return fmt.Errorf("credential DAO did not observe composed identity: %+v", identity)
				}
				inserted, err = scope.AuthorizationDAO().InsertAuthorization(ctx, authorization, 10, now)
				if err != nil {
					return err
				}
				if !inserted {
					return errors.New("authorization DAO rejected available capacity")
				}
				stored, err := scope.AuthorizationDAO().Authorization(ctx, authorization.ID, false)
				if err != nil {
					return err
				}
				if stored.ID != authorization.ID || stored.Status != "pending" || stored.State != authorization.State {
					return fmt.Errorf("authorization DAO lost pending request: %+v", stored)
				}
				if !commit {
					return refusal
				}
				return nil
			})
			wantRows := 0
			if commit {
				wantRows = 1
				if err != nil || completion.Outcome != store.TransactionCommitted {
					t.Fatalf("commit completion = %+v, %v", completion, err)
				}
			} else if !errors.Is(err, refusal) || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("rollback completion = %+v, %v; want original refusal", completion, err)
			}
			var users, clients, grants, access, refresh, authorizations int
			err = database.Pool.QueryRow(ctx, `SELECT
				(SELECT count(*) FROM users WHERE id=$1),
				(SELECT count(*) FROM oauth_clients WHERE id=$2),
				(SELECT count(*) FROM oauth_grants WHERE id=$3),
				(SELECT count(*) FROM oauth_access_tokens WHERE id=$4),
				(SELECT count(*) FROM oauth_refresh_tokens WHERE token_hash=$5),
				(SELECT count(*) FROM oauth_authorizations WHERE id=$6)`, user.ID, client.ID, issue.Grant.ID, issue.AccessID, issue.RefreshHash, authorization.ID).Scan(&users, &clients, &grants, &access, &refresh, &authorizations)
			if err != nil || users != wantRows || clients != wantRows || grants != wantRows || access != wantRows || refresh != wantRows || authorizations != wantRows {
				t.Fatalf("composed rows users/client/grant/access/refresh/authorization=%d/%d/%d/%d/%d/%d; want each %d, error=%v", users, clients, grants, access, refresh, authorizations, wantRows, err)
			}
		})
	}
}

func TestAuthorizationScopeCanceledBeginDoesNotInvokeCallback(t *testing.T) {
	parallelRootDatabaseTest(t)
	database := isolatedStore(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	called := false
	completion, err := database.WriteAuthorizations(ctx, func(store.AuthorizationScope) error {
		called = true
		return nil
	})
	if called || !errors.Is(err, context.Canceled) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("canceled begin callback=%t, completion=%+v, error=%v", called, completion, err)
	}
}

func TestAuthorizationScopeReleasesSingleConnectionBeforeIdentityBudget(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newAuthorizationReceiverFixture(t, "client", "approved")
	before := authorizationReceiverRow(t, t.Context(), f.database, "oauth_authorizations", "id", f.authorization.ID)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	config := f.database.Pool.Config()
	config.MaxConns, config.MinConns = 1, 0
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	limited := &Store{Pool: pool}
	completion, err := limited.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		authorization, err := scope.AuthorizationDAO().AuthorizationByCode(ctx, f.authorization.CodeHash, false)
		if err != nil {
			return err
		}
		if authorization.ID != f.authorization.ID || authorization.Status != f.authorization.Status || !bytes.Equal(authorization.BindingHash, f.authorization.BindingHash) {
			return fmt.Errorf("code lookup returned a different authorization: %+v", authorization)
		}
		return nil
	})
	authorizationReceiverCommitted(t, completion, err)
	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("lookup completion retained %d connections", acquired)
	}
	bucket := model.DeviceRateBucket{Hash: secret.Hash("oauth:token:client:client"), Limit: 240}
	completion, err = limited.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		count, err := scope.IdentityDAO().IncrementDeviceRate(ctx, bucket, f.now)
		if err != nil {
			return err
		}
		if count != 1 {
			return fmt.Errorf("initial client budget count=%d, want 1", count)
		}
		return nil
	})
	authorizationReceiverCommitted(t, completion, err)
	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("identity budget completion retained %d connections", acquired)
	}
	var attempts int
	if err := f.database.Pool.QueryRow(ctx, "SELECT attempts FROM device_authorization_limits WHERE bucket_hash=$1", bucket.Hash).Scan(&attempts); err != nil || attempts != 1 {
		t.Fatalf("persistent client budget=%d, error=%v", attempts, err)
	}
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID, before)
}

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

func releaseRowLockAndDrain(t *testing.T, cancel context.CancelFunc, holder pgx.Tx, done <-chan struct{}) {
	t.Helper()
	cancel()
	ctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
	defer stop()
	if err := holder.Rollback(ctx); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Errorf("release row lock holder: %v", err)
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Error("worker did not stop after cancellation and row lock release")
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
			if name == "expired after request wait" {
				if err := f.database.Pool.QueryRow(ctx, `UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1 RETURNING expires_at`, session.ID).Scan(&session.ExpiresAt); err != nil {
					t.Fatal(err)
				}
			}
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
			defer releaseRowLockAndDrain(t, cancel, holder, done)
			authorizationReceiverAwaitBlock(t, ctx, f.database, holder.Conn().PgConn().PID(), result)
			if name == "expired after request wait" {
				if _, err := f.database.Pool.Exec(ctx, `SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM $1::timestamptz-clock_timestamp())))`, session.ExpiresAt); err != nil {
					t.Fatal(err)
				}
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

type authorizationReceiverFixture struct {
	database      *Store
	now           time.Time
	authorization store.OAuthAuthorization
	client        store.OAuthClient
	issue         store.OAuthFamilyIssue
}

func newAuthorizationReceiverFixture(t *testing.T, clientID, status string) authorizationReceiverFixture {
	t.Helper()
	f := authorizationReceiverFixture{database: isolatedStore(t), now: time.Now().UTC().Truncate(time.Microsecond)}
	user := model.User{ID: uuid.NewString(), UniAuthID: uuid.NewString()}
	f.client = store.OAuthClient{ID: clientID, Metadata: []byte(`{"client_name":"Receiver"}`), CreatedAt: f.now, LastUsedAt: f.now, ExpiresAt: f.now.Add(7 * 24 * time.Hour)}
	f.authorization = authorizationFailureRecord(f.now)
	f.authorization.ClientID, f.authorization.Client = clientID, bytes.Clone(f.client.Metadata)
	f.authorization.BindingHash = secret.Hash("receiver-binding")
	f.issue = store.OAuthFamilyIssue{
		Grant:    store.OAuthGrant{ID: uuid.NewString(), UserID: user.ID, ClientID: clientID, ClientSnapshot: bytes.Clone(f.client.Metadata), Resource: f.authorization.Resource, Scope: f.authorization.Scope, CreatedAt: f.now, ExpiresAt: f.now.Add(30 * 24 * time.Hour)},
		AccessID: uuid.NewString(), AccessHash: secret.Hash("receiver-access"), RefreshHash: secret.Hash("receiver-refresh"), AccessExpiresAt: f.now.Add(time.Hour),
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	completion, err := f.database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		if _, err := scope.IdentityDAO().UpsertUser(ctx, user, f.now); err != nil {
			return err
		}
		inserted, err := scope.OAuthClientDAO().InsertClient(ctx, f.client, 100, f.now)
		if err != nil {
			return err
		}
		if !inserted {
			return errors.New("receiver client fixture unexpectedly reached capacity")
		}
		inserted, err = scope.AuthorizationDAO().InsertAuthorization(ctx, f.authorization, 100, f.now)
		if err != nil {
			return err
		}
		if !inserted {
			return errors.New("receiver authorization fixture unexpectedly reached capacity")
		}
		if status == "approved" {
			expiry := f.now.Add(time.Minute)
			f.authorization.Status, f.authorization.UserID = status, user.ID
			f.authorization.CodeHash, f.authorization.CodeExpiresAt = secret.Hash("receiver-code"), &expiry
			if err := scope.AuthorizationDAO().UpdateAuthorization(ctx, f.authorization); err != nil {
				return err
			}
		}
		f.authorization, err = scope.AuthorizationDAO().Authorization(ctx, f.authorization.ID, false)
		if err != nil {
			return err
		}
		f.client, err = scope.OAuthClientDAO().Client(ctx, clientID, false)
		return err
	})
	authorizationReceiverCommitted(t, completion, err)
	return f
}

func authorizationReceiverCommitted(t *testing.T, completion store.Completion, err error) {
	t.Helper()
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("receiver transaction completion=%+v, error=%v", completion, err)
	}
}

func authorizationReceiverRow(t *testing.T, ctx context.Context, database *Store, table, column string, key any) string {
	t.Helper()
	var row string
	query := "SELECT to_jsonb(row)::text FROM " + pgx.Identifier{table}.Sanitize() + " AS row WHERE " + pgx.Identifier{column}.Sanitize() + "=$1"
	if err := database.Pool.QueryRow(ctx, query, key).Scan(&row); err != nil {
		t.Fatal(err)
	}
	return row
}

func authorizationReceiverCounts(t *testing.T, ctx context.Context, database *Store) [3]int64 {
	t.Helper()
	var counts [3]int64
	if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants),(SELECT count(*) FROM oauth_access_tokens),(SELECT count(*) FROM oauth_refresh_tokens)`).Scan(&counts[0], &counts[1], &counts[2]); err != nil {
		t.Fatal(err)
	}
	return counts
}

func authorizationReceiverClientCounts(t *testing.T, ctx context.Context, database *Store, clientID string) [3]int64 {
	t.Helper()
	var counts [3]int64
	if err := database.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants WHERE client_id=$1),
 (SELECT count(*) FROM oauth_access_tokens a JOIN oauth_grants g ON g.id=a.grant_id WHERE g.client_id=$1),
 (SELECT count(*) FROM oauth_refresh_tokens WHERE client_id=$1)`, clientID).Scan(&counts[0], &counts[1], &counts[2]); err != nil {
		t.Fatal(err)
	}
	return counts
}

func authorizationReceiverAssertRow(t *testing.T, ctx context.Context, database *Store, table, column string, key any, want string) {
	t.Helper()
	if got := authorizationReceiverRow(t, ctx, database, table, column, key); got != want {
		t.Fatalf("%s row changed: got %s, want %s", table, got, want)
	}
}

func TestAuthorizationScopeRollsBackIssuedFamilyAfterUpdateFailure(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newAuthorizationReceiverFixture(t, "update-failure-client", "approved")
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	before := authorizationReceiverRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID)
	counts := authorizationReceiverCounts(t, ctx, f.database)
	const fault = "authorization_receiver_update_failure"
	if _, err := f.database.Pool.Exec(ctx, `CREATE FUNCTION authorization_receiver_update_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'authorization receiver update failure' USING ERRCODE='P0001'; END $$;
 CREATE TRIGGER authorization_receiver_update_failure BEFORE UPDATE ON oauth_authorizations FOR EACH ROW EXECUTE FUNCTION authorization_receiver_update_failure()`); err != nil {
		t.Fatal(err)
	}
	removeFault := func(ctx context.Context) error {
		if _, err := f.database.Pool.Exec(ctx, `DROP TRIGGER IF EXISTS authorization_receiver_update_failure ON oauth_authorizations; DROP FUNCTION IF EXISTS authorization_receiver_update_failure()`); err != nil {
			return err
		}
		return checkFaultTriggerRemoved(ctx, f.database, fault, "oauth_authorizations")
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := removeFault(ctx); err != nil {
			t.Errorf("remove authorization update fault: %v", err)
		}
	})
	consumed := f.authorization
	consumed.Status, consumed.GrantID, consumed.RetainUntil = "consumed", f.issue.Grant.ID, f.issue.Grant.ExpiresAt.Add(24*time.Hour)
	issueAndUpdate := func(scope store.AuthorizationScope) error {
		if err := scope.CredentialFamilyDAO().IssueFamily(ctx, f.issue); err != nil {
			return err
		}
		return scope.AuthorizationDAO().UpdateAuthorization(ctx, consumed)
	}
	completion, err := f.database.WriteAuthorizations(ctx, issueAndUpdate)
	var failure *pgconn.PgError
	if completion.Outcome != store.TransactionNotCommitted || !errors.As(err, &failure) || failure.Code != "P0001" {
		t.Fatalf("update fault completion=%+v, error=%v", completion, err)
	}
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID, before)
	if got := authorizationReceiverCounts(t, ctx, f.database); got != counts {
		t.Fatalf("failed update retained family rows: got %v, want %v", got, counts)
	}
	if got := authorizationReceiverClientCounts(t, ctx, f.database, f.client.ID); got != ([3]int64{}) {
		t.Fatalf("failed client retained issued rows: %v", got)
	}
	if err := removeFault(ctx); err != nil {
		t.Fatal(err)
	}
	completion, err = f.database.WriteAuthorizations(ctx, issueAndUpdate)
	authorizationReceiverCommitted(t, completion, err)
	var complete bool
	if err := f.database.Pool.QueryRow(ctx, `SELECT to_jsonb(row)=($2::jsonb || jsonb_build_object('status','consumed','grant_id',$3::text,'retain_until',to_jsonb($4::timestamptz))) FROM oauth_authorizations row WHERE id=$1`, consumed.ID, before, consumed.GrantID, consumed.RetainUntil).Scan(&complete); err != nil || !complete {
		t.Fatalf("retry did not persist complete consumed authorization: match=%t, error=%v", complete, err)
	}
	want := [3]int64{counts[0] + 1, counts[1] + 1, counts[2] + 1}
	if got := authorizationReceiverCounts(t, ctx, f.database); got != want {
		t.Fatalf("retry family counts: got %v, want %v", got, want)
	}
	if got := authorizationReceiverClientCounts(t, ctx, f.database, f.client.ID); got != ([3]int64{1, 1, 1}) {
		t.Fatalf("retry family client relationships: %v", got)
	}
}

func TestAuthorizationScopeRollsBackClientPin(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newAuthorizationReceiverFixture(t, "dnoac_pin_receiver", "approved")
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	before := authorizationReceiverRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID)
	clientBefore := authorizationReceiverRow(t, ctx, f.database, "oauth_clients", "id", f.client.ID)
	counts := authorizationReceiverCounts(t, ctx, f.database)
	at := f.now.Add(time.Minute)
	refusal := errors.New("fresh time after actual pin failed")
	pin := func(scope store.AuthorizationScope) error {
		pinned, err := scope.OAuthClientDAO().PinClient(ctx, f.client.ID, at)
		if err != nil {
			return err
		}
		if pinned.ID != f.client.ID || !bytes.Equal(pinned.Metadata, f.client.Metadata) || !pinned.CreatedAt.Equal(f.client.CreatedAt) || !pinned.LastUsedAt.Equal(at) || !pinned.ExpiresAt.Equal(at.Add(7*24*time.Hour)) {
			return fmt.Errorf("actual pin did not apply expected touch: %+v", pinned)
		}
		return nil
	}
	completion, err := f.database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		if err := pin(scope); err != nil {
			return err
		}
		return refusal
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, refusal) {
		t.Fatalf("post-pin failure completion=%+v, error=%v", completion, err)
	}
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID, before)
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_clients", "id", f.client.ID, clientBefore)
	if got := authorizationReceiverCounts(t, ctx, f.database); got != counts {
		t.Fatalf("post-pin failure changed family counts: got %v, want %v", got, counts)
	}
	completion, err = f.database.WriteAuthorizations(ctx, pin)
	authorizationReceiverCommitted(t, completion, err)
	var complete bool
	if err := f.database.Pool.QueryRow(ctx, `SELECT to_jsonb(row)=($2::jsonb || jsonb_build_object('last_used_at',to_jsonb($3::timestamptz),'expires_at',to_jsonb($4::timestamptz))) FROM oauth_clients row WHERE id=$1`, f.client.ID, clientBefore, at, at.Add(7*24*time.Hour)).Scan(&complete); err != nil || !complete {
		t.Fatalf("pin retry did not persist only its touch: match=%t, error=%v", complete, err)
	}
}

func TestAuthorizationScopeRollsBackFamilyRevocation(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newAuthorizationReceiverFixture(t, "revocation-client", "approved")
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	consumed := f.authorization
	consumed.Status, consumed.GrantID, consumed.RetainUntil = "consumed", f.issue.Grant.ID, f.issue.Grant.ExpiresAt.Add(24*time.Hour)
	completion, err := f.database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		if err := scope.CredentialFamilyDAO().IssueFamily(ctx, f.issue); err != nil {
			return err
		}
		return scope.AuthorizationDAO().UpdateAuthorization(ctx, consumed)
	})
	authorizationReceiverCommitted(t, completion, err)
	before := authorizationReceiverRow(t, ctx, f.database, "oauth_authorizations", "id", consumed.ID)
	grantBefore := authorizationReceiverRow(t, ctx, f.database, "oauth_grants", "id", f.issue.Grant.ID)
	accessBefore := authorizationReceiverRow(t, ctx, f.database, "oauth_access_tokens", "id", f.issue.AccessID)
	refreshBefore := authorizationReceiverRow(t, ctx, f.database, "oauth_refresh_tokens", "token_hash", f.issue.RefreshHash)
	counts := authorizationReceiverCounts(t, ctx, f.database)
	refusal := errors.New("failure after actual family revocation")
	completion, err = f.database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		changed, err := scope.CredentialFamilyDAO().RevokeFamily(ctx, f.issue.Grant.ID, f.now)
		if err != nil {
			return err
		}
		if !changed {
			return errors.New("initial revocation did not change grant")
		}
		return refusal
	})
	if completion.Outcome != store.TransactionNotCommitted || !errors.Is(err, refusal) {
		t.Fatalf("revocation failure completion=%+v, error=%v", completion, err)
	}
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_authorizations", "id", consumed.ID, before)
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_grants", "id", f.issue.Grant.ID, grantBefore)
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_access_tokens", "id", f.issue.AccessID, accessBefore)
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_refresh_tokens", "token_hash", f.issue.RefreshHash, refreshBefore)
	if got := authorizationReceiverCounts(t, ctx, f.database); got != counts {
		t.Fatalf("revocation rollback changed family counts: got %v, want %v", got, counts)
	}
	completion, err = f.database.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		identity, err := scope.CredentialFamilyDAO().AuthenticateAccess(ctx, f.issue.AccessHash, []store.OAuthBinding{{Resource: f.issue.Grant.Resource, Scope: f.issue.Grant.Scope}}, f.now)
		if err != nil {
			return err
		}
		want := store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: f.issue.Grant.UserID, CredentialID: f.issue.AccessID}, GrantID: f.issue.Grant.ID, ExpiresAt: f.issue.AccessExpiresAt}
		if identity != want {
			return fmt.Errorf("restored access identity=%+v, want %+v", identity, want)
		}
		return nil
	})
	authorizationReceiverCommitted(t, completion, err)
}
