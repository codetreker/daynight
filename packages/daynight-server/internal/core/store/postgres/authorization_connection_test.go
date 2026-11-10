package postgres

import (
	"bytes"
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAuthorizationScopeReleasesSingleConnectionBeforeIdentityBudget(t *testing.T) {
	parallelRootDatabaseTest(t)
	f := newAuthorizationReceiverFixture(t, "client", "approved")
	before := authorizationReceiverRow(t, t.Context(), f.database, "oauth_authorizations", "id", f.authorization.ID)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	config := f.database.Pool.Config()
	config.MaxConns, config.MinConns = 1, 0
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	limited := &Store{Pool: pool}
	completion, err := limited.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
		authorization, err := scope.AuthorizationDAO().AuthorizationByCode(ctx, f.authorization.CodeHash, false)
		if err != nil {
			return err
		}
		if authorization.ID != f.authorization.ID || authorization.Status != f.authorization.Status || !bytes.Equal(authorization.BindingHash, f.authorization.BindingHash) {
			return fmt.Errorf("code lookup returned a different authorization: %+v", authorization)
		}
		return nil
	})
	authorizationReceiverCommitted(t, completion, err)
	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("lookup completion retained %d connections", acquired)
	}
	bucket := model.DeviceRateBucket{Hash: secret.Hash("oauth:token:client:client"), Limit: 240}
	completion, err = limited.WriteIdentity(ctx, func(scope store.IdentityScope) error {
		count, err := scope.IdentityDAO().IncrementDeviceRate(ctx, bucket, f.now)
		if err != nil {
			return err
		}
		if count != 1 {
			return fmt.Errorf("initial client budget count=%d, want 1", count)
		}
		return nil
	})
	authorizationReceiverCommitted(t, completion, err)
	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("identity budget completion retained %d connections", acquired)
	}
	var attempts int
	if err := f.database.Pool.QueryRow(ctx, "SELECT attempts FROM device_authorization_limits WHERE bucket_hash=$1", bucket.Hash).Scan(&attempts); err != nil || attempts != 1 {
		t.Fatalf("persistent client budget=%d, error=%v", attempts, err)
	}
	authorizationReceiverAssertRow(t, ctx, f.database, "oauth_authorizations", "id", f.authorization.ID, before)
}
