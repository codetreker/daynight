package oauth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestOAuthAuthorizationCodeLockObservesCommittedConsumption(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,$3,$3)`, user, uuid.NewString(), now); err != nil {
		t.Fatal(err)
	}
	access, refresh := secret.Random("dnmcp_"), secret.Random("dnmcr_")
	issue := store.OAuthFamilyIssue{
		Grant:    store.OAuthGrant{ID: uuid.NewString(), UserID: user, ClientID: "client", ClientSnapshot: []byte(`{"name":"client"}`), Resource: "https://example.test/mcp", Scope: "daynight:mcp", CreatedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)},
		AccessID: uuid.NewString(), AccessHash: secret.Hash(access), RefreshHash: secret.Hash(refresh), AccessExpiresAt: now.Add(time.Hour),
	}
	_, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		if err := scope.CredentialFamilyDAO().IssueFamily(ctx, issue); err != nil {
			return err
		}
		_, err := scope.CredentialFamilyDAO().RevokeFamily(ctx, issue.Grant.ID, now)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	codeIssue := issue
	codeIssue.Grant.ID, codeIssue.AccessID = uuid.NewString(), uuid.NewString()
	codeIssue.AccessHash, codeIssue.RefreshHash = secret.Hash("code access"), secret.Hash("code refresh")
	record := authorizationRecord(now)
	record.ClientID, record.UserID, record.GrantID = issue.Grant.ClientID, user, codeIssue.Grant.ID
	record.Status, record.State, record.StatePresent = "approved", "", false
	record.CodeHash = secret.Hash("single code")
	expiry := now.Add(time.Minute)
	record.CodeExpiresAt = &expiry
	_, err = db.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		pending := record
		pending.Status = "pending"
		inserted, err := scope.AuthorizationDAO().InsertAuthorization(ctx, pending, 10, now)
		if err != nil {
			return err
		}
		if !inserted {
			return errors.New("normal authorization refused")
		}
		return scope.AuthorizationDAO().UpdateAuthorization(ctx, record)
	})
	if err != nil {
		t.Fatal(err)
	}
	holder, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer holder.Rollback(context.Background())
	holderDAO := oauth.NewDAO(holder)
	current, err := holderDAO.AuthorizationByCode(ctx, record.CodeHash, true)
	if err != nil || current.Status != "approved" {
		t.Fatalf("approved code lock: %+v %v", current, err)
	}
	replay, replayDone := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(replayDone)
		_, err := db.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
			observed, err := scope.AuthorizationDAO().AuthorizationByCode(ctx, record.CodeHash, true)
			if err != nil {
				return err
			}
			if observed.Status != "consumed" {
				return errors.New("code lock did not observe committed consumption")
			}
			return model.ErrNotFound
		})
		replay <- err
	}()
	defer func() {
		cancel()
		_ = holder.Rollback(context.Background())
		select {
		case <-replayDone:
		case <-time.After(2 * time.Second):
			t.Error("authorization replay did not drain")
		}
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text,binding_hash,client_snapshot", holder.Conn().PgConn().PID())
	if err := holderDAO.IssueFamily(ctx, codeIssue); err != nil {
		t.Fatal(err)
	}
	current.Status = "consumed"
	if err := holderDAO.UpdateAuthorization(ctx, current); err != nil {
		t.Fatal(err)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-replay:
		if !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("consumed code replay: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var grants, accesses, refreshes int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants WHERE id=$1),(SELECT count(*) FROM oauth_access_tokens WHERE grant_id=$1),(SELECT count(*) FROM oauth_refresh_tokens WHERE grant_id=$1)`, codeIssue.Grant.ID).Scan(&grants, &accesses, &refreshes); err != nil || grants != 1 || accesses != 1 || refreshes != 1 {
		t.Fatalf("code redemption family=%d/%d/%d error=%v", grants, accesses, refreshes, err)
	}
	var retainedState int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants),(SELECT count(*) FROM oauth_access_tokens),(SELECT count(*) FROM oauth_refresh_tokens),(SELECT count(*) FROM oauth_authorizations WHERE state<>'')`).Scan(&grants, &accesses, &refreshes, &retainedState); err != nil || grants != 2 || accesses != 1 || refreshes != 2 || retainedState != 0 {
		t.Fatalf("issued or revoked family rows changed: grants=%d access=%d refresh=%d state=%d error=%v", grants, accesses, refreshes, retainedState, err)
	}
}

func TestOAuthFamilyGrantLifetimeAcrossDST(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db := isolatedStore(t)
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL TIME ZONE 'America/New_York'`); err != nil {
		t.Fatal(err)
	}
	created := time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC)
	issue := store.OAuthFamilyIssue{
		Grant:    store.OAuthGrant{ID: uuid.NewString(), UserID: uuid.NewString(), ClientID: "client", ClientSnapshot: []byte(`{}`), Resource: "https://example.test/mcp", Scope: "daynight:mcp", CreatedAt: created, ExpiresAt: created.Add(30 * 24 * time.Hour)},
		AccessID: uuid.NewString(), AccessHash: make([]byte, 32), RefreshHash: make([]byte, 32), AccessExpiresAt: created.Add(time.Hour),
	}
	if err := oauth.NewDAO(tx).IssueFamily(ctx, issue); err != nil {
		t.Fatalf("issue across DST: %v", err)
	}
	var expires time.Time
	if err := tx.QueryRow(ctx, `SELECT expires_at FROM oauth_grants WHERE id=$1`, issue.Grant.ID).Scan(&expires); err != nil || !expires.Equal(issue.Grant.ExpiresAt) {
		t.Fatalf("expiry: %v %v", expires, err)
	}
}
