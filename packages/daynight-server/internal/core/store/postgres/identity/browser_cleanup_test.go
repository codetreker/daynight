package identity_test

import (
	"context"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	identity "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/identity"
	oauth "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

func TestBrowserCleanupSkipsRenewalAndDoesNotDeleteCommittedDeadline(t *testing.T) {
	f := newPreviewFixture(t)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	value := secret.Random("dnst_")
	var oldExpiry time.Time
	requireNoError(t, f.db.Pool.QueryRow(ctx, `UPDATE sessions SET token_hash=$2,created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()+interval '1 second' WHERE id=$1 RETURNING expires_at`, f.session.ID, secret.Hash(value)).Scan(&oldExpiry))
	tx, err := f.db.Pool.Begin(ctx)
	requireNoError(t, err)
	defer tx.Rollback(context.Background())
	scope := identity.NewScope(tx, oauth.NewDAO(tx))
	_, err = core.NewIdentity("").AuthenticateBrowserActivity(ctx, scope.IdentityDAO(), value, "")
	requireNoError(t, err)
	// The cleanup reference selects the old committed row while activity holds
	// its lock. A later cleanup must observe the committed renewed deadline.
	identityScopeTest(t, f.db, func(sc store.IdentityScope) error {
		return sc.IdentityDAO().CleanupLoginCredentials(ctx, oldExpiry.Add(time.Hour), oldExpiry.Add(time.Hour))
	})
	requireNoError(t, tx.Commit(ctx))
	identityScopeTest(t, f.db, func(sc store.IdentityScope) error { return sc.IdentityDAO().CleanupCredentials(ctx, time.Now()) })
	identityScopeTest(t, f.db, func(sc store.IdentityScope) error {
		p, err := sc.IdentityDAO().Authenticate(ctx, model.SessionCredential, secret.Hash(value), time.Now().Add(365*24*time.Hour))
		if err == nil && p != f.principal {
			t.Fatal("renewed credential changed")
		}
		return err
	})
	var used *time.Time
	var expires time.Time
	requireNoError(t, f.db.Pool.QueryRow(ctx, `SELECT last_used_at,expires_at FROM sessions WHERE id=$1`, f.session.ID).Scan(&used, &expires))
	if used == nil || !expires.Equal(used.Add(core.SessionLifetime)) {
		t.Fatal("cleanup erased renewal")
	}
}
