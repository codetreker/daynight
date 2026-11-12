package session_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pgoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func testTaskOAuthCredentialRechecksGrantAndToken(t *testing.T, db *postgres.Store, profile string) {
	_, owner, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant, access, _ := sessionOAuthFamily(t, db, owner.UserID, profile, now.Add(-10*time.Minute))
	actor := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID}
	if err := db.Pool.QueryRow(t.Context(), `SELECT id::text FROM oauth_access_tokens WHERE token_hash=$1`, secret.Hash(access)).Scan(&actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	check := func(want bool, resource, scope string, at time.Time) {
		t.Helper()
		for _, lock := range []bool{false, true} {
			sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
				check := dao.ReadOAuthCredential
				if lock {
					check = dao.LockOAuthCredential
				}
				err := check(t.Context(), actor, []store.OAuthBinding{{Resource: resource, Scope: scope, ClientID: sessionOAuthBindings(grant)[0].ClientID}}, at)
				if want && err != nil || !want && !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("credential admission lock=%v valid=%v: %v", lock, want, err)
				}
				return nil
			})
		}
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
	for _, profile := range []string{"mcp", "api"} {
		t.Run(profile, func(t *testing.T) { testTaskOAuthCredentialLocksRemainCompatibleAcrossSessionOrder(t, profile) })
	}
}

func testTaskOAuthCredentialLocksRemainCompatibleAcrossSessionOrder(t *testing.T, profile string) {
	for _, queuedRevoker := range []bool{false, true} {
		t.Run(map[bool]string{false: "two actors", true: "queued revocation"}[queuedRevoker], func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			_, owner, _ := testAuthRecords(t, db)
			grant, access, _ := sessionOAuthFamily(t, db, owner.UserID, profile, time.Now().UTC().Add(-10*time.Minute).Truncate(time.Microsecond))
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
			if err := pgsession.New(submit).LockOAuthCredential(ctx, actor, sessionOAuthBindings(grant), time.Now()); err != nil {
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
				testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text,user_id::text,client_id", submit.Conn().PgConn().PID())
			}
			readCtx, readCancel := context.WithTimeout(ctx, time.Second)
			defer readCancel()
			if err := pgsession.New(dispatch).LockOAuthCredential(readCtx, actor, sessionOAuthBindings(grant), time.Now()); err != nil {
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
	for _, profile := range []string{"mcp", "api"} {
		t.Run(profile, func(t *testing.T) { testTaskOAuthRevocationWaitsForAdmissionAndExpiryIsRecheckedAfterWait(t, profile) })
	}
}

func testTaskOAuthRevocationWaitsForAdmissionAndExpiryIsRecheckedAfterWait(t *testing.T, profile string) {
	for _, mode := range []string{"revocation", "expiry"} {
		t.Run(mode, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			_, owner, _ := testAuthRecords(t, db)
			grant, access, _ := sessionOAuthFamily(t, db, owner.UserID, profile, time.Now().UTC().Add(-10*time.Minute).Truncate(time.Microsecond))
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
				if err := pgsession.New(blocker).LockOAuthCredential(ctx, actor, sessionOAuthBindings(grant), time.Now()); err != nil {
					t.Fatal(err)
				}
				go func() { _, err := pgoauth.NewDAO(waiter).RevokeFamily(ctx, grant.ID, time.Now()); done <- err }()
				testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text,user_id::text,client_id", blocker.Conn().PgConn().PID())
			} else {
				if _, err := blocker.Exec(ctx, `UPDATE oauth_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, actor.CredentialID); err != nil {
					t.Fatal(err)
				}
				go func() {
					done <- pgsession.New(waiter).LockOAuthCredential(ctx, actor, sessionOAuthBindings(grant), time.Now())
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
				if err := dao.LockOAuthCredential(ctx, actor, sessionOAuthBindings(grant), time.Now()); !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("invalid actor re-admitted: %v", err)
				}
				return nil
			})
		})
	}
}

func TestTaskOAuthCredentialReadDoesNotWaitBehindQueuedRevocation(t *testing.T) {
	for _, profile := range []string{"mcp", "api"} {
		t.Run(profile, func(t *testing.T) { testTaskOAuthCredentialReadDoesNotWaitBehindQueuedRevocation(t, profile) })
	}
}

func testTaskOAuthCredentialReadDoesNotWaitBehindQueuedRevocation(t *testing.T, profile string) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	_, owner, _ := testAuthRecords(t, db)
	grant, access, _ := sessionOAuthFamily(t, db, owner.UserID, profile, time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond))
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
	if err := pgsession.New(submit).LockOAuthCredential(ctx, actor, sessionOAuthBindings(grant), time.Now()); err != nil {
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
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text,user_id::text,client_id", submit.Conn().PgConn().PID())
	readCtx, readCancel := context.WithTimeout(ctx, time.Second)
	defer readCancel()
	if err := pgsession.New(dispatch).LockOAuthCredential(readCtx, actor, sessionOAuthBindings(grant), time.Now()); err != nil {
		t.Fatalf("compatible dispatch credential read waited behind revocation: %v", err)
	}
}

func TestTaskOAuthCredentialRechecksGrantAfterWait(t *testing.T) {
	for _, profile := range []string{"mcp", "api"} {
		t.Run(profile, func(t *testing.T) { testTaskOAuthCredentialRechecksGrantAfterWait(t, profile) })
	}
}

func testTaskOAuthCredentialRechecksGrantAfterWait(t *testing.T, profile string) {
	for _, change := range []string{"scope", "expiry", "revocation"} {
		t.Run(change, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			_, owner, _ := testAuthRecords(t, db)
			grant, access, _ := sessionOAuthFamily(t, db, owner.UserID, profile, time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond))
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
			switch change {
			case "scope":
				_, err = blocker.Exec(ctx, `UPDATE oauth_grants SET scope='changed' WHERE id=$1`, grant.ID)
			case "expiry":
				_, err = blocker.Exec(ctx, `UPDATE oauth_grants SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, grant.ID)
			case "revocation":
				_, err = pgoauth.NewDAO(blocker).RevokeFamily(ctx, grant.ID, time.Now())
			}
			if err != nil {
				t.Fatal(err)
			}
			result, finished := make(chan error, 1), make(chan struct{})
			go func() {
				defer close(finished)
				result <- pgsession.New(waiter).LockOAuthCredential(ctx, actor, sessionOAuthBindings(grant), time.Now())
			}()
			defer func() {
				cancel()
				_ = blocker.Rollback(context.Background())
				select {
				case <-finished:
				case <-time.After(time.Second):
					t.Error("credential waiter did not drain")
				}
			}()
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT g.id::text FROM oauth_grants", blocker.Conn().PgConn().PID())
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			if err := testutil.ReceiveQueryResult(t, ctx, result); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("changed grant admitted after lock wait: %v", err)
			}
		})
	}
}

func testSessionOperationRetainsOriginalOAuthActorAfterRevocation(t *testing.T, db *postgres.Store, profile string) {
	_, owner, _ := testAuthRecords(t, db)
	grant, access, refresh := sessionOAuthFamily(t, db, owner.UserID, profile, time.Now().UTC().Add(-time.Minute).Truncate(time.Microsecond))
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

	newer := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID, CredentialID: uuid.NewString()}
	rotatedAt := time.Now().UTC()
	completion, err := db.WriteGrantLifecycle(t.Context(), func(dao store.GrantLifecycleDAO) error {
		locked, err := dao.InspectGrant(t.Context(), grant.ID, true)
		if err != nil {
			return err
		}
		if _, err := dao.Refresh(t.Context(), secret.Hash(refresh), true); err != nil {
			return err
		}
		return dao.RotateRefresh(t.Context(), store.OAuthRotation{Grant: locked, OldHash: secret.Hash(refresh), AccessHash: secret.Hash(uuid.NewString()), RefreshHash: secret.Hash(uuid.NewString()), AccessID: newer.CredentialID, CreatedAt: rotatedAt, AccessExpiresAt: rotatedAt.Add(time.Hour), GrantExpiresAt: locked.ExpiresAt})
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("rotate saved actor family: %v %v", completion, err)
	}
	mustQueryExec(t, db, `UPDATE oauth_access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1`, actor.CredentialID)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		actual, err := dao.SessionOperation(t.Context(), id, operation)
		if err != nil {
			return err
		}
		if actual.Actor != actor {
			t.Fatalf("rotation replaced operation actor: %#v", actual.Actor)
		}
		if err := dao.LockOAuthCredential(t.Context(), actual.Actor, sessionOAuthBindings(grant), time.Now()); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("expired original actor revived by rotation: %v", err)
		}
		return dao.LockOAuthCredential(t.Context(), newer, sessionOAuthBindings(grant), time.Now())
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

func TestTaskOAuthRotatedTokensDoNotDeadlockSessionDispatch(t *testing.T) {
	for _, profile := range []string{"mcp", "api"} {
		t.Run(profile, func(t *testing.T) { testTaskOAuthRotatedTokensDoNotDeadlockSessionDispatch(t, profile) })
	}
}

func testTaskOAuthRotatedTokensDoNotDeadlockSessionDispatch(t *testing.T, profile string) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	_, owner, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant, access, refresh := sessionOAuthFamily(t, db, owner.UserID, profile, now.Add(-10*time.Minute))
	older := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID}
	if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM oauth_access_tokens WHERE token_hash=$1`, secret.Hash(access)).Scan(&older.CredentialID); err != nil {
		t.Fatal(err)
	}
	newer := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID, CredentialID: uuid.NewString()}
	_, err := db.WriteGrantLifecycle(ctx, func(dao store.GrantLifecycleDAO) error {
		locked, err := dao.InspectGrant(ctx, grant.ID, true)
		if err != nil {
			return err
		}
		previous, err := dao.Refresh(ctx, secret.Hash(refresh), true)
		if err != nil {
			return err
		}
		if previous.ConsumedAt != nil {
			return errors.New("fixture refresh already consumed")
		}
		return dao.RotateRefresh(ctx, store.OAuthRotation{Grant: locked, OldHash: secret.Hash(refresh), AccessHash: secret.Hash(uuid.NewString()), RefreshHash: secret.Hash(uuid.NewString()), AccessID: newer.CredentialID, CreatedAt: now, AccessExpiresAt: now.Add(time.Hour), GrantExpiresAt: locked.ExpiresAt})
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, actor := range []model.Principal{older, newer} {
		sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
			return dao.LockOAuthCredential(ctx, actor, sessionOAuthBindings(grant), now)
		})
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
	var revokerXID string
	if err := revoker.QueryRow(ctx, `SELECT pg_current_xact_id()::text`).Scan(&revokerXID); err != nil {
		t.Fatal(err)
	}
	if err := pgsession.New(submit).LockOAuthCredential(ctx, newer, sessionOAuthBindings(grant), now); err != nil {
		t.Fatal(err)
	}
	if _, err := pgsession.New(dispatch).LockSession(ctx, id); err != nil {
		t.Fatal(err)
	}
	submitted, submitDone := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(submitDone)
		_, err := pgsession.New(submit).LockSession(ctx, id)
		submitted <- err
	}()
	defer func() {
		cancel()
		_ = dispatch.Rollback(context.Background())
		select {
		case <-submitDone:
		case <-time.After(time.Second):
			t.Error("submit waiter did not drain")
		}
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT bot_id::text,server_instance", dispatch.Conn().PgConn().PID())
	revoked, revokerDone := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(revokerDone)
		_, err := pgoauth.NewDAO(revoker).RevokeFamily(ctx, grant.ID, now)
		revoked <- err
	}()
	defer func() {
		cancel()
		_ = dispatch.Rollback(context.Background())
		select {
		case <-submitDone:
		case <-time.After(time.Second):
			t.Error("submit waiter did not drain before revocation cleanup")
			return
		}
		_ = submit.Rollback(context.Background())
		select {
		case <-revokerDone:
		case <-time.After(time.Second):
			t.Error("revoker did not drain")
		}
	}()
	// Revocation must stop at the family boundary before deleting either token.
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text,user_id::text,client_id", submit.Conn().PgConn().PID())
	var olderLocked bool
	if err := db.Pool.QueryRow(ctx, `SELECT xmax::text=$2 FROM oauth_access_tokens WHERE id=$1`, older.CredentialID, revokerXID).Scan(&olderLocked); err != nil {
		t.Fatal(err)
	}
	if olderLocked {
		t.Fatal("revocation deleted the older token before admission released its family")
	}
	if err := pgsession.New(dispatch).LockOAuthCredential(ctx, older, sessionOAuthBindings(grant), time.Now()); err != nil {
		t.Fatalf("dispatch credential lock: %v: %v", err, errors.Unwrap(err))
	}
	if err := dispatch.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, submitted); err != nil {
		t.Fatalf("submit session lock: %v", err)
	}
	if err := submit.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, revoked); err != nil {
		t.Fatalf("family revocation: %v", err)
	}
	if err := revoker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for _, actor := range []model.Principal{older, newer} {
		sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
			if err := dao.LockOAuthCredential(ctx, actor, sessionOAuthBindings(grant), time.Now()); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("rotated family actor survived revocation: %v", err)
			}
			return nil
		})
	}
}

func sessionOAuthFamily(t *testing.T, db *postgres.Store, user, profile string, now time.Time) (store.OAuthGrant, string, string) {
	t.Helper()
	if profile == "mcp" {
		return testutil.OAuthFamily(t, db, user, now)
	}
	access, refresh := secret.Random("dnapi_"), secret.Random("dnapr_")
	grant := store.OAuthGrant{ID: uuid.NewString(), UserID: user, ClientID: "societas-bot", ClientSnapshot: []byte(`{"client_id":"societas-bot","client_name":"Societas Bot"}`), Resource: "https://example.test/api/v1", Scope: "daynight:api", CreatedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)}
	completion, err := db.WriteCredentialFamily(t.Context(), func(scope store.CredentialFamilyScope) error {
		return scope.CredentialFamilyDAO().IssueFamily(t.Context(), store.OAuthFamilyIssue{Grant: grant, AccessID: uuid.NewString(), AccessHash: secret.Hash(access), RefreshHash: secret.Hash(refresh), AccessExpiresAt: now.Add(time.Hour)})
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("issue API family: %v %v", completion, err)
	}
	return grant, access, refresh
}

func sessionOAuthBindings(grant store.OAuthGrant) []store.OAuthBinding {
	client := ""
	if grant.Scope == "daynight:api" {
		client = "societas-bot"
	}
	return []store.OAuthBinding{{Resource: grant.Resource, Scope: grant.Scope, ClientID: client}}
}

func TestSessionOAuthAPIBindingChecksActualFamilyAndUser(t *testing.T) {
	db := isolatedStore(t)
	_, owner, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant, access, _ := sessionOAuthFamily(t, db, owner.UserID, "api", now)
	actor := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID}
	if err := db.Pool.QueryRow(t.Context(), `SELECT id::text FROM oauth_access_tokens WHERE token_hash=$1`, secret.Hash(access)).Scan(&actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	api := sessionOAuthBindings(grant)[0]
	mcp := store.OAuthBinding{Resource: "https://example.test/mcp", Scope: "daynight:mcp"}
	for _, tc := range []struct {
		name     string
		actor    model.Principal
		bindings []store.OAuthBinding
		valid    bool
	}{
		{"API only", actor, []store.OAuthBinding{api}, true},
		{"Task API and MCP", actor, []store.OAuthBinding{mcp, api}, true},
		{"MCP only", actor, []store.OAuthBinding{mcp}, false},
		{"wrong client", actor, []store.OAuthBinding{{Resource: api.Resource, Scope: api.Scope, ClientID: "foreign-client"}}, false},
		{"crossed resource and scope", actor, []store.OAuthBinding{{Resource: api.Resource, Scope: mcp.Scope}, {Resource: mcp.Resource, Scope: api.Scope, ClientID: api.ClientID}}, false},
		{"foreign user", model.Principal{Kind: actor.Kind, UserID: uuid.NewString(), CredentialID: actor.CredentialID}, []store.OAuthBinding{api}, false},
		{"missing access", model.Principal{Kind: actor.Kind, UserID: actor.UserID, CredentialID: uuid.NewString()}, []store.OAuthBinding{api}, false},
		{"native kind", model.Principal{Kind: model.PATCredential, UserID: actor.UserID, CredentialID: actor.CredentialID}, []store.OAuthBinding{api}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, lock := range []bool{false, true} {
				sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
					check := dao.ReadOAuthCredential
					if lock {
						check = dao.LockOAuthCredential
					}
					err := check(t.Context(), tc.actor, tc.bindings, now)
					if tc.valid && err != nil || !tc.valid && !errors.Is(err, model.ErrNotFound) {
						t.Fatalf("lock=%v valid=%v: %v", lock, tc.valid, err)
					}
					return nil
				})
			}
		})
	}
	mustQueryExec(t, db, `UPDATE oauth_grants SET client_id='foreign-client' WHERE id=$1`, grant.ID)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.LockOAuthCredential(t.Context(), actor, []store.OAuthBinding{mcp, api}, now); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("changed actual client admitted: %v", err)
		}
		return nil
	})
	mustQueryExec(t, db, `UPDATE oauth_grants SET client_id=$2 WHERE id=$1`, grant.ID, api.ClientID)
	mustQueryExec(t, db, `DELETE FROM users WHERE id=$1`, actor.UserID)
	sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
		if err := dao.ReadOAuthCredential(t.Context(), actor, []store.OAuthBinding{api}, now); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("missing actual user admitted: %v", err)
		}
		return nil
	})
}

func TestSessionOAuthReadonlyPreflightDoesNotAcquireFamilyLocks(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	_, owner, _ := testAuthRecords(t, db)
	grant, access, _ := sessionOAuthFamily(t, db, owner.UserID, "api", time.Now().UTC().Add(-time.Minute))
	actor := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID}
	if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM oauth_access_tokens WHERE token_hash=$1`, secret.Hash(access)).Scan(&actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	writer, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, writer)
	if _, err := writer.Exec(ctx, `UPDATE oauth_grants SET revoked_at=clock_timestamp() WHERE id=$1`, grant.ID); err != nil {
		t.Fatal(err)
	}
	reader, err := db.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, reader)
	readCtx, stop := context.WithTimeout(ctx, time.Second)
	defer stop()
	if err := pgsession.New(reader).ReadOAuthCredential(readCtx, actor, sessionOAuthBindings(grant), time.Now()); err != nil {
		t.Fatalf("readonly preflight waited for writer or attempted locking: %v", err)
	}
	if err := writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := pgsession.New(reader).ReadOAuthCredential(ctx, actor, sessionOAuthBindings(grant), time.Now()); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("readonly preflight reused stale authorization: %v", err)
	}
}

func TestSessionOAuthNaturalExpiryIsFreshAfterTokenLockWait(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	_, owner, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant, access, _ := sessionOAuthFamily(t, db, owner.UserID, "api", now.Add(-time.Minute))
	actor := model.Principal{Kind: model.OAuthCredential, UserID: owner.UserID}
	if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM oauth_access_tokens WHERE token_hash=$1`, secret.Hash(access)).Scan(&actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	var deadline time.Time
	if err := db.Pool.QueryRow(ctx, `UPDATE oauth_access_tokens SET expires_at=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING expires_at`, actor.CredentialID).Scan(&deadline); err != nil {
		t.Fatal(err)
	}
	blocker, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, blocker)
	if _, err := blocker.Exec(ctx, `SELECT id FROM oauth_access_tokens WHERE id=$1 FOR UPDATE`, actor.CredentialID); err != nil {
		t.Fatal(err)
	}
	waiter, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer rollbackSessionTestTransaction(t, waiter)
	result, finished := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(finished)
		result <- pgsession.New(waiter).LockOAuthCredential(ctx, actor, sessionOAuthBindings(grant), now)
	}()
	defer func() {
		cancel()
		_ = blocker.Rollback(context.Background())
		select {
		case <-finished:
		case <-time.After(time.Second):
			t.Error("expiry waiter did not drain")
		}
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text FROM oauth_access_tokens", blocker.Conn().PgConn().PID())
	for {
		var expired bool
		if err := db.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1`, deadline).Scan(&expired); err != nil {
			t.Fatal(err)
		}
		if expired {
			break
		}
		if err := testutil.WaitThreadClock(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := testutil.ReceiveQueryResult(t, ctx, result); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("naturally expired access admitted using pre-wait time: %v", err)
	}
}
