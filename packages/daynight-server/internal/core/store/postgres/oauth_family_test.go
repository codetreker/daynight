package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func familyCredentialAfterTargetLock(t *testing.T, db *Store, issue store.OAuthFamilyIssue) {
	t.Helper()
	projectID, taskID := uuid.NewString(), uuid.NewString()
	mustQueryExec(t, db, `INSERT INTO projects(id,name,repo_url) VALUES($1,'credential lock','example')`, projectID)
	mustQueryExec(t, db, `INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'credential lock')`, taskID, projectID)
	workerID := uuid.NewString()
	putWorkerSnapshot(t, db, workerSnapshotFixture(issue.Grant.UserID, workerID, time.Now().UTC()))
	bot := model.Bot{ID: uuid.NewString(), OwnerUserID: issue.Grant.UserID, WorkerID: workerID, Name: "Credential lock", RequestFingerprint: strings.Repeat("a", 64), ResolvedConfiguration: model.BotConfiguration{WorkerID: workerID, Cwd: "/ordinary", Provider: "codex", Args: []string{}}}
	if err := writeBotTest(db, t.Context(), func(dao store.BotWriteDAO) error { return dao.InsertBot(t.Context(), bot) }); err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.OAuthCredential, UserID: issue.Grant.UserID, CredentialID: issue.AccessID}
	for _, target := range []string{"task", "bot"} {
		func() {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			mustQueryExec(t, db, `UPDATE oauth_access_tokens SET expires_at=$2 WHERE id=$1`, issue.AccessID, issue.AccessExpiresAt)
			_, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
				_, err := scope.CredentialFamilyDAO().AuthenticateAccess(ctx, issue.AccessHash, issue.Grant.Resource, issue.Grant.Scope, time.Now())
				return err
			})
			if err != nil {
				t.Fatal(err)
			}
			holder, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			id, table, prefix := taskID, "tasks", "SELECT deleted_at FROM tasks WHERE project_id="
			if target == "bot" {
				id, table, prefix = bot.ID, "bots", "SELECT id::text FROM bots WHERE id="
			}
			if _, err := holder.Exec(ctx, `SELECT id FROM `+table+` WHERE id=$1 FOR UPDATE`, id); err != nil {
				t.Fatal(err)
			}
			done, finished := make(chan error, 1), make(chan struct{})
			go func() {
				defer close(finished)
				if target == "task" {
					_, err := db.WriteThread(ctx, func(scope store.ThreadScope) error {
						if _, err := scope.TaskDAO().LockTaskPresence(ctx, projectID, taskID); err != nil {
							return err
						}
						_, err := scope.CredentialDAO().Credential(ctx, principal)
						return err
					})
					done <- err
				} else {
					_, err := db.WriteBot(ctx, func(scope store.BotScope) error {
						if _, err := scope.BotDAO().Bot(ctx, bot.ID); err != nil {
							return err
						}
						return scope.BotDAO().Credential(ctx, principal)
					})
					done <- err
				}
			}()
			defer func() {
				cancel()
				_ = holder.Rollback(context.Background())
				select {
				case <-finished:
				case <-time.After(2 * time.Second):
					t.Error("OAuth target lock waiter did not drain")
				}
			}()
			waitTransferTeamLock(t, ctx, db, prefix, holder.Conn().PgConn().PID())
			var expiry time.Time
			if err := db.Pool.QueryRow(ctx, `UPDATE oauth_access_tokens SET expires_at=clock_timestamp()+interval '20 milliseconds' WHERE id=$1 RETURNING expires_at`, issue.AccessID).Scan(&expiry); err != nil {
				t.Fatal(err)
			}
			for {
				var expired bool
				if err := db.Pool.QueryRow(ctx, `SELECT clock_timestamp()>=$1::timestamptz`, expiry).Scan(&expired); err != nil {
					t.Fatal(err)
				}
				if expired {
					break
				}
				if err := waitThreadClock(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("OAuth credential survived %s lock wait: %v", target, err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		}()
	}
	mustQueryExec(t, db, `UPDATE oauth_access_tokens SET expires_at=$2 WHERE id=$1`, issue.AccessID, issue.AccessExpiresAt)
}

func TestOAuthFamilyTransactionAndAdmission(t *testing.T) {
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
	abort := errors.New("abort")
	completion, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		if err := scope.CredentialFamilyDAO().IssueFamily(ctx, issue); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants)+(SELECT count(*) FROM oauth_access_tokens)+(SELECT count(*) FROM oauth_refresh_tokens)`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback rows = %d, %v", count, err)
	}
	completion, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		return scope.CredentialFamilyDAO().IssueFamily(ctx, issue)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("issue: %+v %v", completion, err)
	}
	var storedAccess, storedRefresh []byte
	if err := db.Pool.QueryRow(ctx, `SELECT a.token_hash,r.token_hash FROM oauth_access_tokens a JOIN oauth_refresh_tokens r ON r.grant_id=a.grant_id WHERE a.id=$1`, issue.AccessID).Scan(&storedAccess, &storedRefresh); err != nil || string(storedAccess) != string(secret.Hash(access)) || string(storedRefresh) != string(secret.Hash(refresh)) {
		t.Fatalf("stored hashes: %v", err)
	}
	_, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		dao := scope.CredentialFamilyDAO()
		identity, err := dao.AuthenticateAccess(ctx, secret.Hash(access), issue.Grant.Resource, issue.Grant.Scope, now)
		if err != nil || identity.Principal.UserID != user || identity.Principal.CredentialID != issue.AccessID || identity.Principal.Kind != model.OAuthCredential || identity.GrantID != issue.Grant.ID {
			t.Fatalf("authenticate: %+v %v", identity, err)
		}
		for _, input := range []struct {
			hash            []byte
			resource, scope string
			at              time.Time
		}{
			{secret.Hash(refresh), issue.Grant.Resource, issue.Grant.Scope, now},
			{secret.Hash(access), "https://other/mcp", issue.Grant.Scope, now},
			{secret.Hash(access), issue.Grant.Resource, "other", now},
			{secret.Hash(access), issue.Grant.Resource, issue.Grant.Scope, issue.AccessExpiresAt},
		} {
			if _, err := dao.AuthenticateAccess(ctx, input.hash, input.resource, input.scope, input.at); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("unexpected admission: %v", err)
			}
		}
		grant, err := dao.InspectGrant(ctx, issue.Grant.ID, false)
		if err != nil || grant.UserID != user || grant.ClientID != "client" || grant.RevokedAt != nil {
			t.Fatalf("grant: %+v %v", grant, err)
		}
		active, err := dao.ActiveClientReferences(ctx, "client", now)
		if err != nil || !active {
			t.Fatalf("reference: %v %v", active, err)
		}
		active, err = dao.ActiveClientReferences(ctx, "other", now)
		if err != nil || active {
			t.Fatalf("other reference: %v %v", active, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	familyCredentialAfterTargetLock(t, db, issue)
	_, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		changed, err := scope.CredentialFamilyDAO().RevokeFamily(ctx, issue.Grant.ID, now)
		if err != nil || !changed {
			t.Fatalf("revoke: %v %v", changed, err)
		}
		return abort
	})
	if !errors.Is(err, abort) {
		t.Fatalf("rollback revoke: %v", err)
	}
	_, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		dao := scope.CredentialFamilyDAO()
		if _, err := dao.AuthenticateAccess(ctx, secret.Hash(access), issue.Grant.Resource, issue.Grant.Scope, now); err != nil {
			t.Fatal(err)
		}
		changed, err := dao.RevokeFamily(ctx, issue.Grant.ID, now)
		if err != nil || !changed {
			t.Fatalf("revoke: %v %v", changed, err)
		}
		changed, err = dao.RevokeFamily(ctx, issue.Grant.ID, now)
		if err != nil || changed {
			t.Fatalf("repeat revoke: %v %v", changed, err)
		}
		if _, err := dao.AuthenticateAccess(ctx, secret.Hash(access), issue.Grant.Resource, issue.Grant.Scope, now); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("revoked admitted: %v", err)
		}
		active, err := dao.ActiveClientReferences(ctx, "client", now)
		if err != nil || active {
			t.Fatalf("revoked reference: %v %v", active, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_access_tokens), (SELECT count(*) FROM oauth_refresh_tokens)`).Scan(&count, new(int)); err != nil || count != 0 {
		t.Fatalf("access after revoke: %d %v", count, err)
	}
	codeIssue := issue
	codeIssue.Grant.ID, codeIssue.AccessID = uuid.NewString(), uuid.NewString()
	codeIssue.AccessHash, codeIssue.RefreshHash = secret.Hash("code access"), secret.Hash("code refresh")
	record := authorizationFailureRecord(now)
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
	waitTransferTeamLock(t, ctx, db, "SELECT id::text,binding_hash,client_snapshot", holder.Conn().PgConn().PID())
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

func TestOAuthFamilyRejectsInvalidLifetimes(t *testing.T) {
	ctx := context.Background()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	valid := store.OAuthFamilyIssue{Grant: store.OAuthGrant{ID: uuid.NewString(), UserID: uuid.NewString(), ClientID: "c", ClientSnapshot: []byte(`{}`), Resource: "r", Scope: "daynight:mcp", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, AccessID: uuid.NewString(), AccessHash: make([]byte, 32), RefreshHash: make([]byte, 32), AccessExpiresAt: now.Add(time.Minute)}
	for _, modify := range []func(*store.OAuthFamilyIssue){
		func(v *store.OAuthFamilyIssue) { v.AccessHash = nil },
		func(v *store.OAuthFamilyIssue) { v.RefreshHash = nil },
		func(v *store.OAuthFamilyIssue) { v.AccessExpiresAt = now.Add(2 * time.Hour) },
		func(v *store.OAuthFamilyIssue) { v.Grant.ExpiresAt = now.Add(31 * 24 * time.Hour) },
		func(v *store.OAuthFamilyIssue) { v.Grant.RevokedAt = &now },
	} {
		issue := valid
		modify(&issue)
		_, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
			return scope.CredentialFamilyDAO().IssueFamily(ctx, issue)
		})
		if err == nil {
			t.Fatal("invalid issue accepted")
		}
	}
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM oauth_grants`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid issue persisted: %d %v", count, err)
	}
}

// A calendar-day interval varies across DST when the database session is not UTC.
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
