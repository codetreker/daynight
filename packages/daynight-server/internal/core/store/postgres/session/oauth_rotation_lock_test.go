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

func TestTaskOAuthRotatedTokensDoNotDeadlockSessionDispatch(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	_, owner, _ := testAuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant, access, refresh := testutil.OAuthFamily(t, db, owner.UserID, now.Add(-10*time.Minute))
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
		return dao.RotateRefresh(ctx, store.OAuthRotation{Grant: locked, OldHash: secret.Hash(refresh), AccessHash: secret.Hash(uuid.NewString()), RefreshHash: secret.Hash(uuid.NewString()), AccessID: newer.CredentialID, CreatedAt: now, AccessExpiresAt: now.Add(time.Hour)})
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, actor := range []model.Principal{older, newer} {
		sessionDAOTransaction(t, db, func(dao store.SessionDAO) error {
			return dao.LockOAuthCredential(ctx, actor, grant.Resource, grant.Scope, now)
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
	if err := pgsession.New(submit).LockOAuthCredential(ctx, newer, grant.Resource, grant.Scope, now); err != nil {
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
	if err := pgsession.New(dispatch).LockOAuthCredential(ctx, older, grant.Resource, grant.Scope, time.Now()); err != nil {
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
			if err := dao.LockOAuthCredential(ctx, actor, grant.Resource, grant.Scope, time.Now()); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("rotated family actor survived revocation: %v", err)
			}
			return nil
		})
	}
}
