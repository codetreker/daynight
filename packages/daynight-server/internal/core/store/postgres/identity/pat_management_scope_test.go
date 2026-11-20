package identity_test

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
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type lostPATReceiptWriter struct {
	store.IdentityWriter
	calls int
}

func (w *lostPATReceiptWriter) WriteIdentity(ctx context.Context, fn func(store.IdentityScope) error) (store.Completion, error) {
	w.calls++
	result, err := w.IdentityWriter.WriteIdentity(ctx, fn)
	if w.calls == 1 && err == nil && result.Outcome == store.TransactionCommitted {
		return store.Completion{Outcome: store.TransactionUnknown}, nil
	}
	return result, err
}

func TestScopedPATUnknownEditReadback(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	user, session, _ := testutil.AuthRecords(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	policy, err := scopepolicy.NewPolicy(scopepolicy.PAT, []scopepolicy.ScopeID{"project:read"}, 1)
	requireNoError(t, err)
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user.ID, Name: "test", TokenHash: secret.Hash(secret.Random("dnpat_")), CreatedAt: now, ScopePolicy: &policy}
	identityScopeTest(t, db, func(s store.IdentityScope) error { return s.IdentityDAO().InsertPAT(ctx, pat) })
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"project:read", "task:read"})
	requireNoError(t, err)
	writer := &lostPATReceiptWriter{IdentityWriter: db}
	service := identityservice.NewWithDeviceScopes(writer, nil, "", catalog)
	result, err := service.UpdateScopedPAT(ctx, session, pat.ID, user.ID, 1, catalog.CatalogRevision, []scopepolicy.ScopeID{"task:read"})
	var transaction *store.TransactionError
	if !errors.As(err, &transaction) || transaction.Outcome != store.TransactionUnknown || result.ID != "" || writer.calls != 1 {
		t.Fatalf("edit result=%+v calls=%d err=%v", result, writer.calls, err)
	}
	items, err := service.ListScopedPATs(ctx, session)
	requireNoError(t, err)
	if writer.calls != 2 || len(items) != 1 || items[0].ID != pat.ID || items[0].ScopePolicy == nil || items[0].ScopePolicy.Version() != 2 || !slices.Equal(items[0].ScopePolicy.Scopes(), []scopepolicy.ScopeID{"task:read"}) {
		t.Fatalf("readback=%+v calls=%d", items, writer.calls)
	}
}
