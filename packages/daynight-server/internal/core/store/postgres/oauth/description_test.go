package oauth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	oauthpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func descriptionFixture(t *testing.T, db *postgres.Store, user string, expiry time.Time) model.Principal {
	t.Helper()
	p := model.Principal{Kind: model.SessionCredential, UserID: user, CredentialID: uuid.NewString()}
	_, err := db.Pool.Exec(t.Context(), `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,clock_timestamp(),$4)`, p.CredentialID, user, digest(uuid.NewString()), expiry)
	check(t, err)
	return p
}

func TestGrantDescriptionInterleavesWithCredentialLifecycle(t *testing.T) {
	for _, operation := range []string{"refresh", "revoke", "usage"} {
		t.Run(operation, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			user := addLifecycleUser(t, db)
			grant, _, refresh := lifecycleIssue(t, db, user, time.Now().UTC().Truncate(time.Microsecond))
			p := descriptionFixture(t, db, user, time.Now().Add(time.Hour))
			holder, err := db.Pool.Begin(ctx)
			check(t, err)
			defer holder.Rollback(context.Background())
			snapshot := func() string {
				t.Helper()
				var state string
				check(t, holder.QueryRow(ctx, `SELECT jsonb_build_object('grant',to_jsonb(g)-'description','access',(SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM oauth_access_tokens a WHERE a.grant_id=g.id),'refresh',(SELECT jsonb_agg(to_jsonb(r) ORDER BY r.token_hash) FROM oauth_refresh_tokens r WHERE r.grant_id=g.id))::text FROM oauth_grants g WHERE g.id=$1`, grant.ID).Scan(&state))
				return state
			}
			before := snapshot()
			value := "held description"
			changed, err := oauthpg.NewDAO(holder).UpdateOwnerGrantDescription(ctx, user, grant.ID, nil, &value)
			check(t, err)
			if !changed || snapshot() != before {
				t.Fatal("description update changed other grant or token fields")
			}
			lifecycle := core.NewGrantLifecycle(db)
			usedAt := time.Now().UTC().Truncate(time.Microsecond)
			usage := []model.CredentialUsageEvent{{Kind: model.UsageSubjectOAuthGrant, UserID: user, SubjectID: grant.ID, At: usedAt}}
			done := make(chan error, 1)
			go func() {
				switch operation {
				case "refresh":
					_, err := lifecycle.Rotate(ctx, refresh, grant.ClientID, grant.Resource, func(context.Context, string) error { return nil })
					done <- err
				case "revoke":
					changed, err := lifecycle.RevokeSessionGrant(ctx, p, grant.ID)
					if err == nil && !changed {
						err = errors.New("grant was not revoked")
					}
					done <- err
				case "usage":
					_, err := db.WriteCredentialUsage(ctx, usage)
					done <- err
				}
			}()
			if operation == "usage" {
				// Usage admission deliberately uses NOWAIT and retries at a later batch.
				if err := testutil.ReceiveQueryResult(t, ctx, done); err == nil {
					t.Fatal("usage unexpectedly acquired held grant")
				}
			} else {
				testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text,user_id::text,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at,last_used_at FROM oauth_grants", holder.Conn().PgConn().PID())
			}
			check(t, holder.Commit(ctx))
			if operation == "usage" {
				completion, err := db.WriteCredentialUsage(ctx, usage)
				if err != nil || completion.Outcome != store.TransactionCommitted {
					t.Fatalf("usage after release: %v %v", completion, err)
				}
			} else {
				check(t, testutil.ReceiveQueryResult(t, ctx, done))
			}
			var description *string
			var revoked, used, consumed *time.Time
			var accessCount, refreshCount int
			check(t, db.Pool.QueryRow(ctx, `SELECT description,revoked_at,last_used_at,(SELECT consumed_at FROM oauth_refresh_tokens WHERE token_hash=$2),(SELECT count(*) FROM oauth_access_tokens WHERE grant_id=$1),(SELECT count(*) FROM oauth_refresh_tokens WHERE grant_id=$1) FROM oauth_grants WHERE id=$1`, grant.ID, secret.Hash(refresh)).Scan(&description, &revoked, &used, &consumed, &accessCount, &refreshCount))
			if description == nil || *description != value {
				t.Fatal("lifecycle operation overwrote description")
			}
			switch operation {
			case "refresh":
				if consumed == nil || revoked != nil || used != nil || accessCount != 2 || refreshCount != 2 {
					t.Fatalf("refresh state: %v %v %v %d %d", consumed, revoked, used, accessCount, refreshCount)
				}
			case "revoke":
				if revoked == nil || used != nil || consumed != nil || accessCount != 0 || refreshCount != 1 {
					t.Fatalf("revoke state: %v %v %v %d %d", consumed, revoked, used, accessCount, refreshCount)
				}
			case "usage":
				if used == nil || !used.Equal(usedAt) || revoked != nil || consumed != nil || accessCount != 1 || refreshCount != 1 {
					t.Fatalf("usage state: %v %v %v %d %d", consumed, revoked, used, accessCount, refreshCount)
				}
			}
		})
	}
}

func TestGrantDescriptionInterleavesWithCleanup(t *testing.T) {
	for _, cleanupFirst := range []bool{false, true} {
		name := "edit before cleanup"
		if cleanupFirst {
			name = "cleanup before edit"
		}
		t.Run(name, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			user := addLifecycleUser(t, db)
			grant, _, _ := lifecycleIssue(t, db, user, time.Now().UTC().Add(-62*24*time.Hour))
			p := descriptionFixture(t, db, user, time.Now().Add(time.Hour))
			holder, err := db.Pool.Begin(ctx)
			check(t, err)
			defer holder.Rollback(context.Background())
			dao := oauthpg.NewDAO(holder)
			value := "retained only until cleanup"
			if cleanupFirst {
				_, err := dao.PruneCredentials(ctx, time.Now(), 100)
				check(t, err)
				done := make(chan error, 1)
				go func() {
					_, err := core.NewGrantLifecycle(db).UpdateSessionGrantDescription(ctx, p, user, grant.ID, nil, &value)
					done <- err
				}()
				testutil.WaitTransferTeamLock(t, ctx, db.Pool, "UPDATE oauth_grants SET description=", holder.Conn().PgConn().PID())
				check(t, holder.Commit(ctx))
				if err := testutil.ReceiveQueryResult(t, ctx, done); !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("editing deleted grant: %v", err)
				}
			} else {
				changed, err := dao.UpdateOwnerGrantDescription(ctx, user, grant.ID, nil, &value)
				check(t, err)
				if !changed {
					t.Fatal("description was not updated")
				}
				_, err = core.NewGrantLifecycle(db).PruneCredentials(ctx, 100)
				check(t, err)
				check(t, holder.Commit(ctx))
				var got *string
				check(t, db.Pool.QueryRow(ctx, `SELECT description FROM oauth_grants WHERE id=$1`, grant.ID).Scan(&got))
				if got == nil || *got != value {
					t.Fatal("cleanup did not skip locked grant")
				}
				_, err = core.NewGrantLifecycle(db).PruneCredentials(ctx, 100)
				check(t, err)
			}
			var count int
			check(t, db.Pool.QueryRow(ctx, `SELECT count(*) FROM oauth_grants WHERE id=$1`, grant.ID).Scan(&count))
			if count != 0 {
				t.Fatal("cleanup failed or edit resurrected grant")
			}
		})
	}
}

func TestGrantDescriptionPersistenceAndConflict(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	user := addLifecycleUser(t, db)
	grant, access, refresh := lifecycleIssue(t, db, user, time.Now().UTC().Truncate(time.Microsecond))
	p := descriptionFixture(t, db, user, time.Now().Add(time.Hour))
	s := core.NewGrantLifecycle(db)
	value := "  Workstation  "
	result, err := s.UpdateSessionGrantDescription(ctx, p, user, grant.ID, nil, &value)
	if err != nil || result == nil || *result != "Workstation" {
		t.Fatalf("update: %v %v", result, err)
	}
	list, _, err := s.ListSessionGrants(ctx, p)
	if err != nil || len(list) != 1 || list[0].Description == nil || *list[0].Description != "Workstation" {
		t.Fatalf("list: %+v %v", list, err)
	}
	old := "Workstation"
	if _, err := s.UpdateSessionGrantDescription(ctx, p, user, grant.ID, &old, &old); err != nil {
		t.Fatalf("same value: %v", err)
	}
	_, err = s.UpdateSessionGrantDescription(ctx, p, user, grant.ID, nil, &value)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_conflict" {
		t.Fatalf("stale value: %v", err)
	}
	other := addLifecycleUser(t, db)
	foreign := descriptionFixture(t, db, other, time.Now().Add(time.Hour))
	_, err = s.UpdateSessionGrantDescription(ctx, foreign, other, grant.ID, nil, &value)
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("foreign grant: %v", err)
	}
	var stored *string
	var accessCount, refreshCount int
	var expires time.Time
	check(t, db.Pool.QueryRow(ctx, `SELECT description,expires_at,(SELECT count(*) FROM oauth_access_tokens WHERE grant_id=$1 AND token_hash=$2),(SELECT count(*) FROM oauth_refresh_tokens WHERE grant_id=$1 AND token_hash=$3) FROM oauth_grants WHERE id=$1`, grant.ID, digest(access), digest(refresh)).Scan(&stored, &expires, &accessCount, &refreshCount))
	if stored == nil || *stored != old || !expires.Equal(grant.ExpiresAt) || accessCount != 1 || refreshCount != 1 {
		t.Fatalf("unexpected persisted changes: %v %v %d %d", stored, expires, accessCount, refreshCount)
	}
}

func TestGrantDescriptionConcurrentCompareAndSet(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	grant, _, _ := lifecycleIssue(t, db, user, time.Now().UTC())
	p := descriptionFixture(t, db, user, time.Now().Add(time.Hour))
	holder, err := db.Pool.Begin(ctx)
	check(t, err)
	defer holder.Rollback(context.Background())
	_, err = holder.Exec(ctx, `UPDATE oauth_grants SET description='first' WHERE id=$1 AND description IS NULL`, grant.ID)
	check(t, err)
	done := make(chan error, 1)
	go func() {
		value := "second"
		_, err := core.NewGrantLifecycle(db).UpdateSessionGrantDescription(ctx, p, user, grant.ID, nil, &value)
		done <- err
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "UPDATE oauth_grants SET description=", holder.Conn().PgConn().PID())
	check(t, holder.Commit(ctx))
	err = testutil.ReceiveQueryResult(t, ctx, done)
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_conflict" {
		t.Fatalf("concurrent update: %v", err)
	}
	var stored string
	check(t, db.Pool.QueryRow(ctx, `SELECT description FROM oauth_grants WHERE id=$1`, grant.ID).Scan(&stored))
	if stored != "first" {
		t.Fatalf("lost first update: %q", stored)
	}
}

func TestGrantDescriptionWaitRechecksSessionAndRollsBack(t *testing.T) {
	for _, target := range []string{"grant", "session"} {
		t.Run(target, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			defer cancel()
			user := addLifecycleUser(t, db)
			grant, _, _ := lifecycleIssue(t, db, user, time.Now().UTC())
			p := descriptionFixture(t, db, user, time.Now().Add(2*time.Second))
			holder, err := db.Pool.Begin(ctx)
			check(t, err)
			defer holder.Rollback(context.Background())
			prefix := "UPDATE oauth_grants SET description="
			if target == "grant" {
				_, err = holder.Exec(ctx, `SELECT 1 FROM oauth_grants WHERE id=$1 FOR UPDATE`, grant.ID)
			} else {
				_, err = holder.Exec(ctx, `SELECT 1 FROM sessions WHERE id=$1 FOR UPDATE`, p.CredentialID)
				prefix = "SELECT id::text FROM sessions WHERE id="
			}
			check(t, err)
			done := make(chan error, 1)
			go func() {
				value := "waiting"
				_, err := core.NewGrantLifecycle(db).UpdateSessionGrantDescription(ctx, p, user, grant.ID, nil, &value)
				done <- err
			}()
			testutil.WaitTransferTeamLock(t, ctx, db.Pool, prefix, holder.Conn().PgConn().PID())
			_, err = holder.Exec(ctx, `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ((SELECT expires_at FROM sessions WHERE id=$1)-clock_timestamp())))+0.01)`, p.CredentialID)
			check(t, err)
			check(t, holder.Commit(ctx))
			err = testutil.ReceiveQueryResult(t, ctx, done)
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != "unauthenticated" {
				t.Fatalf("expired session: %v", err)
			}
			var stored *string
			check(t, db.Pool.QueryRow(ctx, `SELECT description FROM oauth_grants WHERE id=$1`, grant.ID).Scan(&stored))
			if stored != nil {
				t.Fatalf("description persisted despite expired session: %q", *stored)
			}
		})
	}
}
