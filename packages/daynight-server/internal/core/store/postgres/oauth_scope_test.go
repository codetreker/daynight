package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func authorizationFailureRecord(now time.Time) store.OAuthAuthorization {
	return store.OAuthAuthorization{ID: uuid.NewString(), BindingHash: make([]byte, 32), Client: []byte(`{}`), ClientID: "client", RedirectURI: "https://client.test/callback", Resource: "https://server.test/mcp", Scope: "daynight:mcp", Challenge: "challenge", State: "state", StatePresent: true, Status: "pending", CreatedAt: now, ExpiresAt: now.Add(10 * time.Minute), RetainUntil: now.Add(24 * time.Hour)}
}

func TestOAuthAuthorizationDAOFailurePaths(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	t.Run("constraint failure rolls back insertion", func(t *testing.T) {
		db := isolatedStore(t)
		now := time.Now().UTC()
		record := authorizationFailureRecord(now)
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
			_, err := core.PruneAuthorizationBatch(ctx, scope.AuthorizationDAO(), now, 9)
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
		var cursor int
		if err = db.Pool.QueryRow(ctx, `SELECT next_kind FROM oauth_authorization_cleanup_cursor WHERE singleton=true`).Scan(&cursor); err != nil || cursor != 0 {
			t.Fatalf("failed prune advanced cursor: %d %v", cursor, err)
		}
	})
}

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

func TestOAuthFamilyTransactionRollbackAndCredentialLocks(t *testing.T) {
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
}

func lifecycleIssue(t *testing.T, db *Store, user string, now time.Time) (store.OAuthGrant, string, string) {
	return testutil.OAuthFamily(t, db, user, now)
}
func addLifecycleUser(t *testing.T, db *Store) string { return testutil.AddOAuthUser(t, db.Pool) }

func TestGrantLifecycleAdmissionDoesNotExhaustPool(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant1, _, refresh1 := lifecycleIssue(t, db, user, now)
	grant2, _, refresh2 := lifecycleIssue(t, db, user, now)
	config := db.Pool.Config()
	config.MaxConns = 2
	config.MinConns = 0
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	limited := &Store{Pool: pool}
	lifecycle := core.NewGrantLifecycle(limited)
	admission := core.PublicAdmission{Writer: limited}
	permit1, ok, err := admission.TakeToken(ctx, "pool-source-1")
	if err != nil || !ok {
		t.Fatalf("permit: %v", err)
	}
	permit2, ok, err := admission.TakeToken(ctx, "pool-source-2")
	if err != nil || !ok {
		t.Fatalf("permit: %v", err)
	}
	ready := make(chan struct{}, 2)
	release := make(chan struct{})
	done := make(chan error, 2)
	for _, req := range []struct {
		grant   store.OAuthGrant
		refresh string
		permit  *core.TokenPermit
	}{{grant1, refresh1, permit1}, {grant2, refresh2, permit2}} {
		go func() {
			_, err := lifecycle.Rotate(ctx, req.refresh, "client", req.grant.Resource, func(ctx context.Context, id string) error {
				ready <- struct{}{}
				select {
				case <-release:
				case <-ctx.Done():
					return ctx.Err()
				}
				ok, err := req.permit.TakeClient(ctx, id)
				if err != nil {
					return err
				}
				if !ok {
					return core.ErrRateLimited
				}
				return nil
			})
			done <- err
		}()
	}
	for range 2 {
		select {
		case <-ready:
		case <-ctx.Done():
			t.Fatal("rotations did not reach admission")
		}
	}
	close(release)
	for range 2 {
		if err := <-done; err != nil {
			t.Fatalf("rotation with two-connection pool: %v", err)
		}
	}
}
