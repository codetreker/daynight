package session_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestTaskOAuthCredentialRechecksGrantAndToken(t *testing.T) {
	db := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant, access, _ := testutil.OAuthFamily(t, db, owner.UserID, now.Add(-10*time.Minute))
	actor := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID}
	if err := db.Pool.QueryRow(t.Context(), `SELECT id::text FROM oauth_access_tokens WHERE token_hash=$1`, secret.Hash(access)).Scan(&actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	check := func(want bool, resource, scope string, at time.Time) {
		t.Helper()
		sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
			err := dao.LockOAuthCredential(t.Context(), actor, resource, scope, at)
			if want && err != nil || !want && !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("credential admission valid=%v: %v", want, err)
			}
			return nil
		})
	}
	check(true, grant.Resource, grant.Scope, now)
	check(false, "https://other.example/mcp", grant.Scope, now)
	check(false, grant.Resource, "wrong:scope", now)
	check(false, grant.Resource, grant.Scope, grant.ExpiresAt)
	mustQueryExec(t, db, `UPDATE oauth_grants SET scope='changed' WHERE id=$1`, grant.ID)
	check(false, grant.Resource, grant.Scope, now)
	mustQueryExec(t, db, `UPDATE oauth_grants SET scope=$2,expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, grant.ID, grant.Scope)
	check(false, grant.Resource, grant.Scope, now)
	mustQueryExec(t, db, `UPDATE oauth_grants SET expires_at=$2,revoked_at=clock_timestamp() WHERE id=$1`, grant.ID, grant.ExpiresAt)
	check(false, grant.Resource, grant.Scope, now)
	mustQueryExec(t, db, `UPDATE oauth_grants SET revoked_at=NULL WHERE id=$1`, grant.ID)
	mustQueryExec(t, db, `UPDATE oauth_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, actor.CredentialID)
	check(false, grant.Resource, grant.Scope, now)
}

func TestTaskOAuthCredentialLocksRemainCompatibleAcrossSessionOrder(t *testing.T) {
	for _, queuedRevoker := range []bool{false, true} {
		t.Run(map[bool]string{false: "two actors", true: "queued revocation"}[queuedRevoker], func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			_, owner, _ := testAuthRecords(t, db)
			grant, access, _ := testutil.OAuthFamily(t, db, owner.UserID, time.Now().UTC().Add(-10*time.Minute).Truncate(time.Microsecond))
			actor := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID}
			if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM oauth_access_tokens WHERE token_hash=$1`, secret.Hash(access)).Scan(&actor.CredentialID); err != nil {
				t.Fatal(err)
			}
			project := queryProject(t, db, 1)
			task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
			id, claim := uuid.NewString(), uuid.NewString()
			sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
				return dao.InsertTaskSession(ctx, store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}}}})
			})
			submit, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer submit.Rollback(context.Background())
			dispatch, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer dispatch.Rollback(context.Background())
			revoker, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer revoker.Rollback(context.Background())
			if err := pgsession.New(submit).LockOAuthCredential(ctx, actor, grant.Resource, grant.Scope, time.Now()); err != nil {
				t.Fatal(err)
			}
			if _, err := pgsession.New(dispatch).LockSession(ctx, id); err != nil {
				t.Fatal(err)
			}
			waiting, finished := make(chan error, 1), make(chan struct{})
			go func() { defer close(finished); _, err := pgsession.New(submit).LockSession(ctx, id); waiting <- err }()
			defer func() {
				cancel()
				_ = dispatch.Rollback(context.Background())
				select {
				case <-finished:
				case <-time.After(time.Second):
					t.Error("submit waiter did not drain")
				}
			}()
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT bot_id::text,server_instance", dispatch.Conn().PgConn().PID())
			revoked, revocationFinished := make(chan error, 1), make(chan struct{})
			if queuedRevoker {
				go func() {
					defer close(revocationFinished)
					_, err := pgoauth.NewDAO(revoker).RevokeFamily(ctx, grant.ID, time.Now())
					revoked <- err
				}()
				defer func() {
					cancel()
					_ = submit.Rollback(context.Background())
					_ = dispatch.Rollback(context.Background())
					select {
					case <-revocationFinished:
					case <-time.After(time.Second):
						t.Error("revoker did not drain")
					}
				}()
				testutil.WaitTransferTeamLock(t, ctx, db.Pool, "DELETE FROM oauth_access_tokens", submit.Conn().PgConn().PID())
			}
			readCtx, readCancel := context.WithTimeout(ctx, time.Second)
			defer readCancel()
			if err := pgsession.New(dispatch).LockOAuthCredential(readCtx, actor, grant.Resource, grant.Scope, time.Now()); err != nil {
				t.Fatalf("dispatch credential lock deadlocked with submit/revoker: %v", err)
			}
			if err := dispatch.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := <-waiting; err != nil {
				t.Fatal(err)
			}
			if err := submit.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if queuedRevoker {
				if err := <-revoked; err != nil {
					t.Fatal(err)
				}
				if err := revoker.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}

func TestTaskOAuthRevocationWaitsForAdmissionAndExpiryIsRecheckedAfterWait(t *testing.T) {
	for _, mode := range []string{"revocation", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			_, owner, _ := testAuthRecords(t, db)
			grant, access, _ := testutil.OAuthFamily(t, db, owner.UserID, time.Now().UTC().Add(-10*time.Minute).Truncate(time.Microsecond))
			actor := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID}
			if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM oauth_access_tokens WHERE token_hash=$1`, secret.Hash(access)).Scan(&actor.CredentialID); err != nil {
				t.Fatal(err)
			}
			blocker, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer blocker.Rollback(context.Background())
			waiter, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer waiter.Rollback(context.Background())
			done := make(chan error, 1)
			if mode == "revocation" {
				if err := pgsession.New(blocker).LockOAuthCredential(ctx, actor, grant.Resource, grant.Scope, time.Now()); err != nil {
					t.Fatal(err)
				}
				go func() { _, err := pgoauth.NewDAO(waiter).RevokeFamily(ctx, grant.ID, time.Now()); done <- err }()
				testutil.WaitTransferTeamLock(t, ctx, db.Pool, "DELETE FROM oauth_access_tokens", blocker.Conn().PgConn().PID())
			} else {
				if _, err := blocker.Exec(ctx, `UPDATE oauth_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, actor.CredentialID); err != nil {
					t.Fatal(err)
				}
				go func() {
					done <- pgsession.New(waiter).LockOAuthCredential(ctx, actor, grant.Resource, grant.Scope, time.Now())
				}()
				testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text FROM oauth_access_tokens", blocker.Conn().PgConn().PID())
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			result := <-done
			if mode == "revocation" {
				if result != nil {
					t.Fatal(result)
				}
			} else if !errors.Is(result, model.ErrNotFound) {
				t.Fatalf("expiry after lock wait = %v", result)
			}
			if err := waiter.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
				if err := dao.LockOAuthCredential(ctx, actor, grant.Resource, grant.Scope, time.Now()); !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("invalid actor re-admitted: %v", err)
				}
				return nil
			})
		})
	}
}

func TestTaskOAuthCredentialReadDoesNotWaitBehindQueuedRevocation(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	_, owner, _ := testAuthRecords(t, db)
	grant, access, _ := testutil.OAuthFamily(t, db, owner.UserID, time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond))
	actor := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID}
	if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM oauth_access_tokens WHERE token_hash=$1`, secret.Hash(access)).Scan(&actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	submit, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer submit.Rollback(context.Background())
	revoker, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer revoker.Rollback(context.Background())
	dispatch, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer dispatch.Rollback(context.Background())
	if err := pgsession.New(submit).LockOAuthCredential(ctx, actor, grant.Resource, grant.Scope, time.Now()); err != nil {
		t.Fatal(err)
	}
	revoked := make(chan error, 1)
	go func() { _, err := pgoauth.NewDAO(revoker).RevokeFamily(ctx, grant.ID, time.Now()); revoked <- err }()
	defer func() {
		cancel()
		_ = submit.Rollback(context.Background())
		_ = dispatch.Rollback(context.Background())
		select {
		case <-revoked:
		case <-time.After(time.Second):
			t.Error("revoker did not drain")
		}
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "DELETE FROM oauth_access_tokens", submit.Conn().PgConn().PID())
	readCtx, readCancel := context.WithTimeout(ctx, time.Second)
	defer readCancel()
	if err := pgsession.New(dispatch).LockOAuthCredential(readCtx, actor, grant.Resource, grant.Scope, time.Now()); err != nil {
		t.Fatalf("compatible dispatch credential read waited behind revocation: %v", err)
	}
}

func TestSessionOperationRetainsOriginalOAuthActorAfterRevocation(t *testing.T) {
	db := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, db)
	grant, access, _ := testutil.OAuthFamily(t, db, owner.UserID, time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond))
	actor := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID}
	if err := db.Pool.QueryRow(t.Context(), `SELECT id::text FROM oauth_access_tokens WHERE token_hash=$1`, secret.Hash(access)).Scan(&actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	project := queryProject(t, db, 1)
	task := queryTask(t, db, project.ID, 2, model.TaskInProgress)
	id, claim, operation := uuid.NewString(), uuid.NewString(), uuid.NewString()
	fence := sp.Fence{SessionID: id, ClaimID: claim, ExecutionGeneration: "1"}
	receipt := sp.Operation{Fence: fence, Protocol: sp.Protocol, OperationID: operation, Kind: "send_message", State: "accepted"}
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.InsertTaskSession(t.Context(), store.SessionRegistration{Location: store.SessionLocation{SessionID: id, ProjectID: project.ID, TaskID: task.ID}, ClaimID: claim, OwnerID: owner.UserID, RegistrationID: uuid.NewString(), Registration: []byte(`{}`), Snapshot: sp.Snapshot{ControllerFence: sp.ControllerFence{Fence: fence}, Identity: sp.Identity{ProjectID: project.ID, TaskID: task.ID}}}); err != nil {
			return err
		}
		return dao.InsertSessionOperation(t.Context(), store.SessionOperation{SessionID: id, OperationID: operation, Seq: 1, Hash: []byte("intent"), Actor: actor, Command: sp.Command{Fence: fence, Protocol: sp.Protocol, OperationID: operation, Kind: "send_message", Payload: []byte(`{}`)}, Receipt: receipt})
	})
	revoker, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer revoker.Rollback(context.Background())
	if _, err := pgoauth.NewDAO(revoker).RevokeFamily(t.Context(), grant.ID, time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := revoker.Commit(t.Context()); err != nil {
		t.Fatal(err)
	}
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		actual, err := dao.SessionOperation(t.Context(), id, operation)
		if err != nil {
			return err
		}
		if actual.Actor != actor || actual.Receipt != receipt {
			t.Fatalf("original actor or receipt changed after revocation: %#v", actual)
		}
		return nil
	})
}
