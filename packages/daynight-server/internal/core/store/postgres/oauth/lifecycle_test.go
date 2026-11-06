package oauth_test

import (
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestLifecyclePersistenceAndBoundedFairCleanup(t *testing.T) {
	tx, dao := transaction(t)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond)
	current := family(now, "client")
	check(t, dao.IssueFamily(ctx, current))
	for _, locked := range []bool{false, true} {
		refresh, err := dao.Refresh(ctx, current.RefreshHash, locked)
		check(t, err)
		if refresh.GrantID != current.Grant.ID || refresh.ClientID != "client" || refresh.ConsumedAt != nil || !refresh.ExpiresAt.Equal(current.Grant.ExpiresAt) {
			t.Fatalf("refresh: %+v", refresh)
		}
	}
	id, err := dao.AccessGrant(ctx, current.AccessHash)
	check(t, err)
	if id != current.Grant.ID {
		t.Fatalf("access grant: %s", id)
	}
	owners, err := dao.OwnerGrants(ctx, current.Grant.UserID)
	check(t, err)
	if len(owners) != 1 || owners[0].ID != current.Grant.ID {
		t.Fatalf("owners: %+v", owners)
	}
	empty, err := dao.OwnerGrants(ctx, uuid.NewString())
	check(t, err)
	if len(empty) != 0 {
		t.Fatal("foreign grant exposed")
	}
	rotated := store.OAuthRotation{Grant: current.Grant, OldHash: current.RefreshHash, AccessHash: digest("new-access"), RefreshHash: digest("new-refresh"), AccessID: uuid.NewString(), CreatedAt: now.Add(time.Second), AccessExpiresAt: now.Add(time.Hour)}
	check(t, dao.RotateRefresh(ctx, rotated))
	old, err := dao.Refresh(ctx, current.RefreshHash, false)
	check(t, err)
	if old.ConsumedAt == nil {
		t.Fatal("old refresh not consumed")
	}
	fresh, err := dao.Refresh(ctx, rotated.RefreshHash, false)
	check(t, err)
	if fresh.ConsumedAt != nil || !fresh.ExpiresAt.Equal(current.Grant.ExpiresAt) {
		t.Fatalf("new refresh: %+v", fresh)
	}
	id, err = dao.AccessGrant(ctx, rotated.AccessHash)
	check(t, err)
	if id != current.Grant.ID {
		t.Fatalf("rotated access grant: %s", id)
	}
	for range 4 {
		old := family(now.Add(-62*24*time.Hour), "expired-client")
		check(t, dao.IssueFamily(ctx, old))
	}
	for range 3 {
		n, err := dao.PruneCredentials(ctx, now, 1)
		check(t, err)
		if n != 1 {
			t.Fatalf("one-row budget: %d", n)
		}
	}
	var grants, access, refresh int
	check(t, tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants WHERE client_id='expired-client'),(SELECT count(*) FROM oauth_access_tokens WHERE expires_at<=$1),(SELECT count(*) FROM oauth_refresh_tokens WHERE expires_at<=$1)`, now).Scan(&grants, &access, &refresh))
	if grants != 3 || access != 3 || refresh != 3 {
		t.Fatalf("unfair cleanup: %d %d %d", grants, access, refresh)
	}
	n, err := dao.PruneCredentials(ctx, now, 100)
	check(t, err)
	if n != 9 {
		t.Fatalf("remaining cleanup: %d", n)
	}
	n, err = dao.PruneCredentials(ctx, now, 0)
	check(t, err)
	if n != 0 {
		t.Fatalf("zero budget: %d", n)
	}
}
