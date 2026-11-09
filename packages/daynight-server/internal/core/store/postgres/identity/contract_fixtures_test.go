package identity_test

import (
	"context"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
)

func isolatedStore(t *testing.T) *postgres.Store {
	t.Helper()
	return testutil.OpenStore(t, postgres.Open)
}

func identityScopeTest(t *testing.T, db *postgres.Store, op func(store.IdentityScope) error) {
	t.Helper()
	requireNoError(t, testutil.IdentityWrite(context.Background(), db, op))
}
