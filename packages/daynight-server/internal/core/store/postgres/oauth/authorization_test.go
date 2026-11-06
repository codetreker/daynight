package oauth_test

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func authorizationRecord(at time.Time) store.OAuthAuthorization {
	return store.OAuthAuthorization{ID: uuid.NewString(), BindingHash: digest(uuid.NewString()), Client: json.RawMessage(`{"client_name": "Tool"}`), ClientID: "client", RedirectURI: "https://client.test/callback", Resource: "https://server.test/mcp", Scope: "daynight:mcp", Challenge: "S256-challenge", State: "opaque state", StatePresent: true, Status: "pending", CreatedAt: at, ExpiresAt: at.Add(10 * time.Minute), RetainUntil: at.Add(24 * time.Hour)}
}
func TestAuthorizationPersistenceCapacityAndCodeLookup(t *testing.T) {
	tx, dao := transaction(t)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)
	input := authorizationRecord(now.Add(-time.Hour))
	created, err := dao.InsertAuthorization(ctx, input, 1, now)
	check(t, err)
	if !created {
		t.Fatal("authorization not inserted")
	}
	expected := input
	expected.CreatedAt = now
	expected.ExpiresAt = now.Add(10 * time.Minute)
	expected.RetainUntil = now.Add(24 * time.Hour)
	for _, lock := range []bool{false, true} {
		got, err := dao.Authorization(ctx, input.ID, lock)
		check(t, err)
		if !authorizationEqual(got, expected) {
			t.Fatalf("authorization=%#v, want=%#v", got, expected)
		}
	}
	overflow := authorizationRecord(now)
	created, err = dao.InsertAuthorization(ctx, overflow, 1, now)
	check(t, err)
	if created {
		t.Fatal("pending authorization exceeded capacity")
	}
	_, err = dao.Authorization(ctx, overflow.ID, false)
	missing(t, err)
	approved := expected
	approved.State = ""
	approved.StatePresent = false
	approved.Status = "approved"
	approved.UserID = uuid.NewString()
	approved.GrantID = uuid.NewString()
	approved.CodeHash = digest("authorization-code")
	codeExpiry := now.Add(time.Minute)
	approved.CodeExpiresAt = &codeExpiry
	check(t, dao.UpdateAuthorization(ctx, approved))
	for _, lock := range []bool{false, true} {
		got, err := dao.AuthorizationByCode(ctx, approved.CodeHash, lock)
		check(t, err)
		if !authorizationEqual(got, approved) {
			t.Fatalf("code authorization=%#v, want=%#v", got, approved)
		}
	}
	_, err = dao.AuthorizationByCode(ctx, digest("wrong-code"), false)
	missing(t, err)
	created, err = dao.InsertAuthorization(ctx, overflow, 1, now)
	check(t, err)
	if !created {
		t.Fatal("approved authorization consumed pending capacity")
	}
	_, err = tx.Exec(ctx, `UPDATE oauth_authorizations SET expires_at=$2 WHERE id=$1`, overflow.ID, now)
	check(t, err)
	third := authorizationRecord(now)
	created, err = dao.InsertAuthorization(ctx, third, 1, now)
	check(t, err)
	if !created {
		t.Fatal("expired pending authorization consumed capacity")
	}
}

func TestAuthorizationPruneHonorsBatchLimitAndRetention(t *testing.T) {
	tx, dao := transaction(t)
	ctx := t.Context()
	now := time.Now().UTC().Truncate(time.Microsecond).Add(time.Hour)
	pending, denied, active := authorizationRecord(now), authorizationRecord(now), authorizationRecord(now)
	for _, a := range []store.OAuthAuthorization{pending, denied, active} {
		created, err := dao.InsertAuthorization(ctx, a, 10, now)
		check(t, err)
		if !created {
			t.Fatal("fixture capacity refused")
		}
	}
	_, err := tx.Exec(ctx, `UPDATE oauth_authorizations SET expires_at=$2 WHERE id=$1`, pending.ID, now.Add(-time.Minute))
	check(t, err)
	_, err = tx.Exec(ctx, `UPDATE oauth_authorizations SET status='denied',retain_until=$2 WHERE id=$1`, denied.ID, now.Add(-time.Minute))
	check(t, err)
	changed, err := core.PruneAuthorizationBatch(ctx, dao, now, 1)
	check(t, err)
	if changed != 1 {
		t.Fatalf("first prune changed=%d", changed)
	}
	expired, err := dao.Authorization(ctx, pending.ID, false)
	check(t, err)
	if expired.Status != "expired" || expired.State != "" || expired.StatePresent {
		t.Fatalf("expired state=%#v", expired)
	}
	retained, err := dao.Authorization(ctx, denied.ID, false)
	check(t, err)
	if retained.Status != "denied" {
		t.Fatalf("batch limit lost denied row=%#v", retained)
	}
	changed, err = core.PruneAuthorizationBatch(ctx, dao, now, 10)
	check(t, err)
	if changed != 1 {
		t.Fatalf("retention prune changed=%d", changed)
	}
	_, err = dao.Authorization(ctx, denied.ID, false)
	missing(t, err)
	live, err := dao.Authorization(ctx, active.ID, false)
	check(t, err)
	if live.Status != "pending" || live.State != active.State || !live.StatePresent {
		t.Fatalf("live authorization changed=%#v", live)
	}
	retained, err = dao.Authorization(ctx, pending.ID, false)
	check(t, err)
	if retained.Status != "expired" {
		t.Fatalf("unexpired retention row lost=%#v", retained)
	}
	changed, err = core.PruneAuthorizationBatch(ctx, dao, now, 10)
	check(t, err)
	if changed != 0 {
		t.Fatalf("repeat prune changed=%d", changed)
	}
}

func authorizationEqual(actual, expected store.OAuthAuthorization) bool {
	actual.CreatedAt, actual.ExpiresAt, actual.RetainUntil = actual.CreatedAt.UTC(), actual.ExpiresAt.UTC(), actual.RetainUntil.UTC()
	expected.CreatedAt, expected.ExpiresAt, expected.RetainUntil = expected.CreatedAt.UTC(), expected.ExpiresAt.UTC(), expected.RetainUntil.UTC()
	if actual.CodeExpiresAt != nil {
		at := actual.CodeExpiresAt.UTC()
		actual.CodeExpiresAt = &at
	}
	if expected.CodeExpiresAt != nil {
		at := expected.CodeExpiresAt.UTC()
		expected.CodeExpiresAt = &at
	}
	return reflect.DeepEqual(actual, expected)
}
