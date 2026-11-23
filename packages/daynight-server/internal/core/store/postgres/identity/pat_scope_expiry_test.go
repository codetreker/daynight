package identity_test

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
)

func TestPATScopeAndExpiryConcurrentWrites(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, _, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"}, 1)
	requireNoError(t, err)
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, TokenHash: hash("scope-expiry-concurrent"), Name: "scope and expiry", CreatedAt: now, ScopePolicy: &policy}
	identityScopeTest(t, db, func(scope store.IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, pat) })
	holder, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer holder.Rollback(context.Background())
	_, err = holder.Exec(ctx, `SELECT id FROM personal_access_tokens WHERE id=$1 FOR UPDATE`, pat.ID)
	requireNoError(t, err)
	scopeTx, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	expiryTx, err := db.Pool.Begin(ctx)
	requireNoError(t, err)
	expiry := now.Add(24 * time.Hour)
	done := make(chan error, 2)
	remaining := 2
	defer func() {
		cancel()
		_ = holder.Rollback(context.Background())
		for remaining > 0 {
			select {
			case <-done:
				remaining--
			case <-time.After(5 * time.Second):
				t.Error("concurrent writes did not stop")
				return
			}
		}
	}()
	go func() {
		defer scopeTx.Rollback(context.Background())
		dao := pgidentity.NewScope(scopeTx, oauth.NewDAO(scopeTx)).IdentityDAO().(store.PATScopeDAO)
		_, err := dao.ComparePATScope(ctx, user.ID, pat.ID, 1, []scopepolicy.ScopeID{"project:read"}, now)
		if err == nil {
			err = scopeTx.Commit(ctx)
		}
		done <- err
	}()
	go func() {
		defer expiryTx.Rollback(context.Background())
		dao := pgidentity.NewScope(expiryTx, oauth.NewDAO(expiryTx)).IdentityDAO()
		_, err := dao.SetPATExpiry(ctx, pat.ID, &expiry)
		if err == nil {
			err = expiryTx.Commit(ctx)
		}
		done <- err
	}()
	for _, pid := range []int32{int32(scopeTx.Conn().PgConn().PID()), int32(expiryTx.Conn().PgConn().PID())} {
		for {
			var blocked bool
			requireNoError(t, db.Pool.QueryRow(ctx, `SELECT cardinality(pg_blocking_pids($1::integer))>0`, pid).Scan(&blocked))
			if blocked {
				break
			}
			select {
			case err := <-done:
				remaining--
				t.Fatalf("write did not wait: %v", err)
			case <-ctx.Done():
				t.Fatal("writes did not wait")
			case <-time.After(10 * time.Millisecond):
			}
		}
	}
	requireNoError(t, holder.Commit(ctx))
	for remaining > 0 {
		select {
		case err := <-done:
			remaining--
			requireNoError(t, err)
		case <-ctx.Done():
			t.Fatal("writes did not finish")
		}
	}
	identityScopeTest(t, db, func(scope store.IdentityScope) error {
		got, err := scope.IdentityDAO().(store.PATScopeDAO).PATByHash(ctx, pat.TokenHash, now)
		if err != nil {
			return err
		}
		if got.ExpiresAt == nil || !got.ExpiresAt.Equal(expiry) || got.ScopePolicy == nil || got.ScopePolicy.Version() != 2 || !slices.Equal(got.ScopePolicy.Scopes(), []scopepolicy.ScopeID{"project:read"}) {
			t.Fatalf("concurrent updates lost fields: %+v", got)
		}
		return nil
	})
}
