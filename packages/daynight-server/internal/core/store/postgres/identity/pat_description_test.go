package identity_test

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestPATDescriptionStorageAndOwnerCAS(t *testing.T) {
	tx, scope := identityTransaction(t)
	ctx, dao := t.Context(), scope.IdentityDAO()
	management := dao.(store.PATManagementDAO)
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := uuid.NewString()
	expired := now.Add(-time.Hour)
	original := "original"
	pat := model.PersonalAccessToken{ID: uuid.NewString(), UserID: user, TokenHash: hash("description-pat"), Name: "test", CreatedAt: now.Add(-2 * time.Hour), ExpiresAt: &expired, Description: &original}
	requireNoError(t, dao.InsertPAT(ctx, pat))
	legacy, err := dao.ListPATs(ctx, user, now)
	requireNoError(t, err)
	if len(legacy) != 0 {
		t.Fatal("legacy list included expired PAT")
	}
	items, err := management.ListAllPATs(ctx, user)
	requireNoError(t, err)
	if len(items) != 1 || items[0].Description == nil || *items[0].Description != original {
		t.Fatalf("metadata: %+v", items)
	}
	newValue := "changed"
	changed, err := management.ComparePATDescription(ctx, uuid.NewString(), pat.ID, &original, &newValue)
	requireNoError(t, err)
	if changed {
		t.Fatal("cross-owner update")
	}
	changed, err = management.ComparePATDescription(ctx, user, pat.ID, &original, &newValue)
	requireNoError(t, err)
	if !changed {
		t.Fatal("expected update")
	}
	changed, err = management.ComparePATDescription(ctx, user, pat.ID, &original, nil)
	requireNoError(t, err)
	if changed {
		t.Fatal("stale update succeeded")
	}
	changed, err = management.ComparePATDescription(ctx, user, pat.ID, &newValue, &newValue)
	requireNoError(t, err)
	if !changed {
		t.Fatal("same-value update failed")
	}
	changed, err = management.ComparePATDescription(ctx, user, pat.ID, &newValue, nil)
	requireNoError(t, err)
	if !changed {
		t.Fatal("clear failed")
	}
	exists, err := management.PATExists(ctx, user, pat.ID)
	requireNoError(t, err)
	if !exists {
		t.Fatal("owner row missing")
	}
	exists, err = management.PATExists(ctx, uuid.NewString(), pat.ID)
	requireNoError(t, err)
	if exists {
		t.Fatal("cross-owner row visible")
	}
	var desc *string
	var storedHash []byte
	var storedExpiry time.Time
	requireNoError(t, tx.QueryRow(ctx, `SELECT description,token_hash,expires_at FROM personal_access_tokens WHERE id=$1`, pat.ID).Scan(&desc, &storedHash, &storedExpiry))
	if desc != nil || string(storedHash) != string(pat.TokenHash) || !storedExpiry.Equal(expired) {
		t.Fatal("description write changed credential fields")
	}
}
