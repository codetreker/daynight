package postgres

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialpolicy"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCurrentCredentialAuthorizationBindsOAuthResourceAndProfile(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	ctx := t.Context()
	user := testutil.AddOAuthUser(t, db.Pool)
	now := time.Now().UTC()
	policy, err := scopepolicy.NewPolicy(scopepolicy.MCP, []scopepolicy.ScopeID{"task:read"}, 1)
	if err != nil {
		t.Fatal(err)
	}
	source := &credentialpolicy.Source{Database: db, Origin: "https://example.test"}
	for _, profile := range []string{"daynight:mcp", "daynight:api"} {
		t.Run(profile, func(t *testing.T) {
			p := model.Principal{Kind: model.OAuthCredential, UserID: user, CredentialID: uuid.NewString()}
			grant := store.OAuthGrant{ID: uuid.NewString(), UserID: user, ClientID: "client", ClientSnapshot: []byte(`{}`), Resource: source.Origin + "/mcp", Scope: profile, CreatedAt: now, ExpiresAt: now.Add(time.Hour), ScopePolicy: &policy}
			want := model.ScopedMCPProfile
			if profile == "daynight:api" {
				grant.ClientID, grant.Resource, grant.ScopePolicy = "societas-bot", source.Origin+"/api/v1", nil
				want = model.OAuthAPIProfile
			}
			_, err := db.WriteCredentialFamily(ctx, func(s store.CredentialFamilyScope) error {
				return s.CredentialFamilyDAO().IssueFamily(ctx, store.OAuthFamilyIssue{Grant: grant, AccessID: p.CredentialID, AccessHash: testutil.DeviceHash(p.CredentialID), RefreshHash: testutil.DeviceHash(grant.ID), AccessExpiresAt: now.Add(time.Hour)})
			})
			if err != nil {
				t.Fatal(err)
			}
			a, err := source.Current(ctx, p)
			if err != nil || a.Principal != p || a.Profile != want || (profile == "daynight:mcp" && (a.Policy == nil || a.Policy.Version() != 1 || !slices.Equal(a.Policy.Scopes(), policy.Scopes()))) || (profile == "daynight:api" && a.Policy != nil) {
				t.Fatalf("current OAuth authorization: %+v %v", a, err)
			}
			wrongOrigin := &credentialpolicy.Source{Database: db, Origin: "https://other.example.test"}
			_, err = wrongOrigin.Current(ctx, p)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
				t.Fatalf("credential crossed resource origin: %v", err)
			}
			if profile == "daynight:api" {
				if _, err := db.Pool.Exec(ctx, `UPDATE oauth_grants SET client_id='other-client' WHERE id=$1`, grant.ID); err != nil {
					t.Fatal(err)
				}
				if _, err = source.Current(ctx, p); !errors.As(err, &fault) || fault.Code != "unauthenticated" {
					t.Fatalf("fixed API profile accepted another client: %v", err)
				}
			}
			if _, err := db.Pool.Exec(ctx, `UPDATE oauth_grants SET revoked_at=clock_timestamp() WHERE id=$1`, grant.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = source.Current(ctx, p); !errors.As(err, &fault) || fault.Code != "unauthenticated" {
				t.Fatalf("revoked grant accepted: %v", err)
			}
		})
	}
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if err := tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	p := model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: uuid.NewString()}
	if _, err := (credentialAuthorization{tx}).CurrentCredentialAuthorization(ctx, p, source.Origin, false); !errors.Is(err, pgx.ErrTxClosed) {
		t.Fatalf("closed transaction failure lost: %v", err)
	}
}

func TestCredentialAuthorizationScopesRetainPolicyLockAndSnapshotBoundary(t *testing.T) {
	parallelRootDatabaseTest(t)
	db := isolatedStore(t)
	ctx := t.Context()
	actor, team := testutil.TeamFixture(t, db)
	project, _, err := testutil.CreateProjectInTeam(ctx, db, actor, uuid.NewString(), "Policy scope", "https://example.test/scopes", &team.ID)
	if err != nil {
		t.Fatal(err)
	}
	p := model.Principal{Kind: model.PATCredential, UserID: actor.UserID, CredentialID: uuid.NewString()}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,business_scopes,scope_version) VALUES($1,$2,$3,'policy scope',clock_timestamp(),ARRAY['task:read'],7)`, p.CredentialID, p.UserID, testutil.DeviceHash(p.CredentialID)); err != nil {
		t.Fatal(err)
	}
	source := &credentialpolicy.Source{Database: db, Origin: "https://example.test"}
	assertPolicy := func(t *testing.T, scope any, lock bool) error {
		t.Helper()
		a, err := source.InScope(ctx, scope, p, lock)
		if err != nil {
			return err
		}
		if a.Principal != p || a.Profile != model.ScopedPATProfile || a.Policy == nil || a.Policy.Version() != 7 || !slices.Equal(a.Policy.Scopes(), []scopepolicy.ScopeID{"task:read"}) {
			t.Fatalf("scope returned a different credential policy: %+v", a)
		}
		if lock {
			writer, err := db.Pool.Begin(ctx)
			if err != nil {
				return err
			}
			defer writer.Rollback(context.Background())
			if _, err := writer.Exec(ctx, `SET LOCAL lock_timeout='100ms'`); err != nil {
				return err
			}
			_, err = writer.Exec(ctx, `UPDATE personal_access_tokens SET scope_version=8 WHERE id=$1`, p.CredentialID)
			var failure *pgconn.PgError
			if !errors.As(err, &failure) || failure.Code != "55P03" {
				t.Fatalf("credential policy edit was not blocked by owning scope: %v", err)
			}
		}
		return nil
	}
	for _, test := range []struct {
		name string
		run  func(func(any, bool) error) error
	}{
		{"worker", func(check func(any, bool) error) error {
			_, err := db.WriteWorker(ctx, func(s store.WorkerScope) error { return check(s, true) })
			return err
		}},
		{"bot", func(check func(any, bool) error) error {
			_, err := db.WriteBot(ctx, func(s store.BotScope) error { return check(s, true) })
			return err
		}},
		{"team", func(check func(any, bool) error) error {
			_, err := db.WriteTeam(ctx, team.ID, func(s store.TeamWriteScope) error { return check(s, true) })
			return err
		}},
		{"project", func(check func(any, bool) error) error {
			_, err := db.WriteProjectDirectMember(ctx, project.ID, func(s store.ProjectDirectMemberScope) error { return check(s, true) })
			return err
		}},
		{"session", func(check func(any, bool) error) error {
			_, err := db.WriteSession(ctx, func(s store.SessionScope) error { return check(s, true) })
			return err
		}},
		{"usage", func(check func(any, bool) error) error {
			_, err := db.WriteUsage(ctx, func(s store.UsageScope) error { return check(s, true) })
			return err
		}},
		{"prompt write", func(check func(any, bool) error) error {
			_, err := db.WritePrompt(ctx, func(s store.PromptWriteScope) error { return check(s, true) })
			return err
		}},
		{"prompt read", func(check func(any, bool) error) error {
			return db.ReadPromptSnapshot(ctx, func(s store.PromptSnapshot) error { return check(s, false) })
		}},
		{"snapshot", func(check func(any, bool) error) error {
			return db.ReadSnapshot(ctx, func(s store.SnapshotScope) error {
				if _, err := source.InScope(ctx, s, p, true); err == nil {
					return errors.New("read snapshot allowed a credential lock")
				}
				return check(s, false)
			})
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := test.run(func(scope any, lock bool) error { return assertPolicy(t, scope, lock) }); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestCurrentCredentialAuthorizationRejectsExpiryDuringLockWait(t *testing.T) {
	for _, kind := range []model.CredentialKind{model.PATCredential, model.SessionCredential} {
		t.Run(string(kind), func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			p := model.Principal{Kind: kind, UserID: uuid.NewString(), CredentialID: uuid.NewString()}
			table := "sessions"
			columns, values := "", ""
			if kind == model.PATCredential {
				table = "personal_access_tokens"
				columns = ",name,business_scopes,scope_version"
				values = ",'expiry probe',ARRAY['task:read'],1"
			}
			var expiry time.Time
			err := db.Pool.QueryRow(ctx, "INSERT INTO "+table+"(id,user_id,token_hash,created_at,expires_at"+columns+") VALUES($1,$2,decode(repeat('01',32),'hex'),clock_timestamp(),clock_timestamp()+interval '2 seconds'"+values+") RETURNING expires_at", p.CredentialID, p.UserID).Scan(&expiry)
			if err != nil {
				t.Fatal(err)
			}
			holder, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer holder.Rollback(context.Background())
			if _, err = holder.Exec(ctx, "SELECT id FROM "+table+" WHERE id=$1 FOR UPDATE", p.CredentialID); err != nil {
				t.Fatal(err)
			}
			reader, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Rollback(context.Background())
			done := make(chan error, 1)
			go func() {
				_, err := (credentialAuthorization{reader}).CurrentCredentialAuthorization(ctx, p, "https://example.test", true)
				done <- err
			}()
			defer func() {
				cancel()
				_ = holder.Rollback(context.Background())
				select {
				case <-done:
				case <-time.After(time.Second):
				}
			}()
			for {
				var blocked bool
				if err := db.Pool.QueryRow(ctx, "SELECT $1::integer=ANY(pg_blocking_pids($2::integer))", int32(holder.Conn().PgConn().PID()), int32(reader.Conn().PgConn().PID())).Scan(&blocked); err != nil {
					t.Fatal(err)
				}
				if blocked {
					break
				}
				select {
				case err := <-done:
					t.Fatalf("reader did not wait: %v", err)
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(5 * time.Millisecond):
				}
			}
			if _, err := db.Pool.Exec(ctx, "SELECT pg_sleep(GREATEST(0,extract(epoch FROM $1::timestamptz-clock_timestamp())))", expiry); err != nil {
				t.Fatal(err)
			}
			if err := holder.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case err := <-done:
				done <- err
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
					t.Fatalf("expired credential accepted after lock wait: %v", err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
		})
	}
}

func expireCredentialDuringRowWait(t *testing.T, ctx context.Context, pool *pgxpool.Pool, holder pgx.Tx, table, credential, queryPrefix string, operation func(context.Context) error) error {
	t.Helper()
	expires := testutil.ArmCredentialExpiry(t, ctx, pool, table, credential, 2)
	workerCtx, cancel := context.WithCancel(ctx)
	result := make(chan error, 1)
	stopped := make(chan struct{})
	defer releaseRowLockAndDrain(t, cancel, holder, stopped)
	go func() {
		defer close(stopped)
		result <- operation(workerCtx)
	}()
	testutil.WaitTransferTeamLock(t, ctx, pool, queryPrefix, holder.Conn().PgConn().PID())
	testutil.WaitForCredentialExpiry(t, ctx, pool, expires)
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	return testutil.ReceiveQueryResult(t, ctx, result)
}
