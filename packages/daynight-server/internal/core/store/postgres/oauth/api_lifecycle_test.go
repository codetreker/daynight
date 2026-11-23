package oauth_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	coreoauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestAPILifecycleRollingAndOriginalRefreshReplayWindow(t *testing.T) {
	for _, expiredReplay := range []bool{false, true} {
		name := "valid replay revokes"
		if expiredReplay {
			name = "expired replay preserves renewal"
		}
		t.Run(name, func(t *testing.T) {
			db := isolatedStore(t)
			ctx, now := t.Context(), time.Now().UTC().Truncate(time.Microsecond)
			user := addLifecycleUser(t, db)
			var issued coreoauth.IssuedFamily
			_, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
				var err error
				issued, err = coreoauth.IssueAPIFamily(ctx, scope.CredentialFamilyDAO(), user, "https://example.test/api/v1", now.Add(-29*24*time.Hour))
				return err
			})
			check(t, err)
			lifecycle := coreoauth.NewGrantLifecycle(db)
			admit := func(context.Context, string) error { return nil }
			rotated, err := lifecycle.Rotate(ctx, issued.RefreshToken, coreoauth.APIClientID, issued.Grant.Resource, admit)
			check(t, err)
			if rotated.Grant == nil || !rotated.Grant.CreatedAt.Equal(issued.Grant.CreatedAt) || !rotated.Grant.ExpiresAt.After(issued.Grant.CreatedAt.Add(coreoauth.GrantLifetime)) || rotated.ExpiresIn != 3600 {
				t.Fatalf("rolling family: %+v", rotated)
			}
			var expires, oldExpires time.Time
			var consumed *time.Time
			check(t, db.Pool.QueryRow(ctx, `SELECT g.expires_at,r.expires_at,r.consumed_at FROM oauth_grants g JOIN oauth_refresh_tokens r ON r.grant_id=g.id WHERE r.token_hash=$1`, secret.Hash(issued.RefreshToken)).Scan(&expires, &oldExpires, &consumed))
			if !expires.Equal(rotated.Grant.ExpiresAt) || !oldExpires.Equal(issued.Grant.ExpiresAt) || consumed == nil {
				t.Fatalf("rotation persisted deadlines: grant=%v old=%v consumed=%v", expires, oldExpires, consumed)
			}
			if expiredReplay {
				_, err = db.Pool.Exec(ctx, `UPDATE oauth_refresh_tokens SET expires_at=$2 WHERE token_hash=$1`, secret.Hash(issued.RefreshToken), now.Add(-time.Microsecond))
				check(t, err)
			}
			_, err = lifecycle.Rotate(ctx, issued.RefreshToken, coreoauth.APIClientID, issued.Grant.Resource, admit)
			if !errors.Is(err, coreoauth.ErrInvalidGrant) {
				t.Fatalf("replay: %v", err)
			}
			var revoked *time.Time
			check(t, db.Pool.QueryRow(ctx, `SELECT revoked_at FROM oauth_grants WHERE id=$1`, issued.Grant.ID).Scan(&revoked))
			if (revoked == nil) != expiredReplay {
				t.Fatalf("replay revoked=%v expired=%v", revoked, expiredReplay)
			}
			_, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
				_, err := scope.CredentialFamilyDAO().AuthenticateAccess(ctx, secret.Hash(rotated.AccessToken), []store.OAuthBinding{{Resource: issued.Grant.Resource, Scope: coreoauth.APIScope, ClientID: coreoauth.APIClientID}}, time.Now())
				return err
			})
			if expiredReplay {
				check(t, err)
			} else {
				missing(t, err)
			}
		})
	}
}

func TestAPILifecycleConcurrentRefreshHasOneSuccessAndReplayRevokes(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	var issued coreoauth.IssuedFamily
	_, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		var err error
		issued, err = coreoauth.IssueAPIFamily(ctx, scope.CredentialFamilyDAO(), user, "https://example.test/api/v1", time.Now())
		return err
	})
	check(t, err)
	lifecycle := coreoauth.NewGrantLifecycle(db)
	start := make(chan struct{})
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for range 2 {
		workers.Go(func() {
			<-start
			_, err := lifecycle.Rotate(ctx, issued.RefreshToken, coreoauth.APIClientID, issued.Grant.Resource, func(context.Context, string) error { return nil })
			results <- err
		})
	}
	close(start)
	workers.Wait()
	close(results)
	successes, invalid := 0, 0
	for err := range results {
		if err == nil {
			successes++
		} else if errors.Is(err, coreoauth.ErrInvalidGrant) {
			invalid++
		} else {
			t.Fatal(err)
		}
	}
	if successes != 1 || invalid != 1 {
		t.Fatalf("rotation outcomes: success=%d invalid=%d", successes, invalid)
	}
	var revoked *time.Time
	var accessCount, refreshCount int
	check(t, db.Pool.QueryRow(ctx, `SELECT revoked_at,(SELECT count(*) FROM oauth_access_tokens WHERE grant_id=$1),(SELECT count(*) FROM oauth_refresh_tokens WHERE grant_id=$1) FROM oauth_grants WHERE id=$1`, issued.Grant.ID).Scan(&revoked, &accessCount, &refreshCount))
	if revoked == nil || accessCount != 0 || refreshCount != 2 {
		t.Fatalf("concurrent replay: revoked=%v access=%d refresh=%d", revoked, accessCount, refreshCount)
	}
}

func TestAPILifecycleRefreshExpiresWhileWaitingForGrant(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	var issued coreoauth.IssuedFamily
	_, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		var err error
		issued, err = coreoauth.IssueAPIFamily(ctx, scope.CredentialFamilyDAO(), user, "https://example.test/api/v1", time.Now())
		return err
	})
	check(t, err)
	holder, err := db.Pool.Begin(ctx)
	check(t, err)
	defer holder.Rollback(context.Background())
	_, err = holder.Exec(ctx, `SELECT 1 FROM oauth_grants WHERE id=$1 FOR UPDATE`, issued.Grant.ID)
	check(t, err)
	done, finished := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(finished)
		_, err := coreoauth.NewGrantLifecycle(db).Rotate(ctx, issued.RefreshToken, coreoauth.APIClientID, issued.Grant.Resource, func(context.Context, string) error { return nil })
		done <- err
	}()
	defer func() {
		cancel()
		_ = holder.Rollback(context.Background())
		select {
		case <-finished:
		case <-time.After(2 * time.Second):
			t.Error("API expiry waiter did not drain")
		}
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text,user_id::text,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at,last_used_at FROM oauth_grants", holder.Conn().PgConn().PID())
	var expiry time.Time
	check(t, holder.QueryRow(ctx, `UPDATE oauth_refresh_tokens SET expires_at=clock_timestamp()+interval '20 milliseconds' WHERE token_hash=$1 RETURNING expires_at`, secret.Hash(issued.RefreshToken)).Scan(&expiry))
	_, err = holder.Exec(ctx, `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.005)`, expiry)
	check(t, err)
	check(t, holder.Commit(ctx))
	select {
	case err := <-done:
		if !errors.Is(err, coreoauth.ErrInvalidGrant) {
			t.Fatalf("expired API refresh: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var consumed, revoked *time.Time
	var grants, access, refresh int
	check(t, db.Pool.QueryRow(ctx, `SELECT r.consumed_at,g.revoked_at,(SELECT count(*) FROM oauth_grants),(SELECT count(*) FROM oauth_access_tokens),(SELECT count(*) FROM oauth_refresh_tokens) FROM oauth_refresh_tokens r JOIN oauth_grants g ON g.id=r.grant_id WHERE r.token_hash=$1`, secret.Hash(issued.RefreshToken)).Scan(&consumed, &revoked, &grants, &access, &refresh))
	if consumed != nil || revoked != nil || grants != 1 || access != 1 || refresh != 1 {
		t.Fatalf("expired API refresh mutated family: consumed=%v revoked=%v rows=%d/%d/%d", consumed, revoked, grants, access, refresh)
	}
}
