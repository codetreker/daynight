package oauth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/google/uuid"
)

func apiFamily(now time.Time) store.OAuthFamilyIssue {
	issue := family(now, "societas-bot")
	issue.Grant.Resource, issue.Grant.Scope = "https://example.test/api/v1", "daynight:api"
	issue.Grant.ClientSnapshot = []byte(`{"client_id":"societas-bot","client_name":"Societas Bot"}`)
	return issue
}

func apiBinding(issue store.OAuthFamilyIssue) []store.OAuthBinding {
	return []store.OAuthBinding{{Resource: issue.Grant.Resource, Scope: issue.Grant.Scope, ClientID: issue.Grant.ClientID}}
}

func TestAPIAccessUsesActualFamilyBindingAndEffectiveDeadline(t *testing.T) {
	tx, dao := transaction(t)
	ctx, now := t.Context(), time.Now().UTC().Truncate(time.Microsecond)
	issue := apiFamily(now)
	_, err := tx.Exec(ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,$3,$3)`, issue.Grant.UserID, uuid.NewString(), now)
	check(t, err)
	check(t, dao.IssueFamily(ctx, issue))
	bindings := apiBinding(issue)
	identity, err := dao.AuthenticateAccess(ctx, issue.AccessHash, bindings, now)
	check(t, err)
	actor := identity.Principal
	if !identity.ExpiresAt.Equal(issue.AccessExpiresAt) {
		t.Fatalf("access expiry: %+v", actor)
	}
	check(t, dao.ReadAccess(ctx, actor, bindings, now))
	check(t, dao.LockAccess(ctx, actor, bindings, now))
	for _, binding := range [][]store.OAuthBinding{
		nil,
		{{Resource: issue.Grant.Resource, Scope: issue.Grant.Scope, ClientID: "foreign-client"}},
		{{Resource: issue.Grant.Resource, Scope: "daynight:mcp"}, {Resource: "https://other.test/api/v1", Scope: issue.Grant.Scope, ClientID: issue.Grant.ClientID}},
	} {
		_, err := dao.AuthenticateAccess(ctx, issue.AccessHash, binding, now)
		missing(t, err)
		missing(t, dao.ReadAccess(ctx, actor, binding, now))
		missing(t, dao.LockAccess(ctx, actor, binding, now))
	}
	shorter := now.Add(30 * time.Minute)
	_, err = tx.Exec(ctx, `UPDATE oauth_grants SET expires_at=$2 WHERE id=$1`, issue.Grant.ID, shorter)
	check(t, err)
	identity, err = dao.AuthenticateAccess(ctx, issue.AccessHash, bindings, now)
	check(t, err)
	if !identity.ExpiresAt.Equal(shorter) {
		t.Fatalf("family expiry: %+v", identity.Principal)
	}
	credential, err := pg.ThreadCredential(ctx, tx, actor, "")
	check(t, err)
	if credential.ExpiresAt == nil || !credential.ExpiresAt.Equal(shorter) {
		t.Fatalf("reader expiry: %+v", credential)
	}
	missing(t, dao.ReadAccess(ctx, actor, bindings, shorter))
	missing(t, dao.LockAccess(ctx, actor, bindings, shorter))
	foreign := actor
	foreign.UserID = uuid.NewString()
	missing(t, dao.ReadAccess(ctx, foreign, bindings, now))
	_, err = pg.ThreadCredential(ctx, tx, foreign, "")
	missing(t, err)
	_, err = tx.Exec(ctx, `UPDATE oauth_grants SET user_id=$2 WHERE id=$1`, issue.Grant.ID, foreign.UserID)
	check(t, err)
	_, err = dao.AuthenticateAccess(ctx, issue.AccessHash, bindings, now)
	missing(t, err)
	_, err = pg.ThreadCredential(ctx, tx, actor, "")
	missing(t, err)
	_, err = tx.Exec(ctx, `UPDATE oauth_grants SET user_id=$2,revoked_at=$3 WHERE id=$1`, issue.Grant.ID, actor.UserID, now)
	check(t, err)
	_, err = pg.ThreadCredential(ctx, tx, actor, " FOR SHARE")
	missing(t, err)
}

func TestAPIRotationPreservesOldDeadlinesAndAtomicRollback(t *testing.T) {
	db := isolatedStore(t)
	ctx, now := t.Context(), time.Now().UTC().Truncate(time.Microsecond)
	issue := apiFamily(now.Add(-29 * 24 * time.Hour))
	_, err := db.Pool.Exec(ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,$3,$3)`, issue.Grant.UserID, uuid.NewString(), now)
	check(t, err)
	_, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		return scope.CredentialFamilyDAO().IssueFamily(ctx, issue)
	})
	check(t, err)
	rotation := store.OAuthRotation{Grant: issue.Grant, OldHash: issue.RefreshHash, AccessHash: digest("api-rotation-access"), RefreshHash: digest("api-rotation-refresh"), AccessID: uuid.NewString(), CreatedAt: now, AccessExpiresAt: now.Add(time.Hour), GrantExpiresAt: now.Add(30 * 24 * time.Hour)}
	rollback := errors.New("reject after rotation")
	completion, err := db.WriteGrantLifecycle(ctx, func(dao store.GrantLifecycleDAO) error {
		_, err := dao.InspectGrant(ctx, issue.Grant.ID, true)
		if err != nil {
			return err
		}
		_, err = dao.Refresh(ctx, issue.RefreshHash, true)
		if err != nil {
			return err
		}
		if err := dao.RotateRefresh(ctx, rotation); err != nil {
			return err
		}
		return rollback
	})
	if !errors.Is(err, rollback) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	assertState := func(rotated bool) {
		t.Helper()
		var created, expires, oldAccess, oldRefresh time.Time
		var consumed *time.Time
		var count int
		check(t, db.Pool.QueryRow(ctx, `SELECT g.created_at,g.expires_at,a.expires_at,r.expires_at,r.consumed_at,(SELECT count(*) FROM oauth_access_tokens WHERE id=$2) FROM oauth_grants g JOIN oauth_access_tokens a ON a.id=$3 JOIN oauth_refresh_tokens r ON r.token_hash=$4 WHERE g.id=$1`, issue.Grant.ID, rotation.AccessID, issue.AccessID, issue.RefreshHash).Scan(&created, &expires, &oldAccess, &oldRefresh, &consumed, &count))
		want := issue.Grant.ExpiresAt
		if rotated {
			want = rotation.GrantExpiresAt
		}
		if !created.Equal(issue.Grant.CreatedAt) || !expires.Equal(want) || !oldAccess.Equal(issue.AccessExpiresAt) || !oldRefresh.Equal(issue.Grant.ExpiresAt) || (consumed != nil) != rotated || (count == 1) != rotated {
			t.Fatalf("rotation persisted inconsistent state: created=%v expires=%v access=%v refresh=%v consumed=%v new=%d", created, expires, oldAccess, oldRefresh, consumed, count)
		}
	}
	assertState(false)
	_, err = db.WriteGrantLifecycle(ctx, func(dao store.GrantLifecycleDAO) error {
		_, err := dao.InspectGrant(ctx, issue.Grant.ID, true)
		if err != nil {
			return err
		}
		_, err = dao.Refresh(ctx, issue.RefreshHash, true)
		if err != nil {
			return err
		}
		return dao.RotateRefresh(ctx, rotation)
	})
	check(t, err)
	assertState(true)
	var refreshExpires time.Time
	check(t, db.Pool.QueryRow(ctx, `SELECT expires_at FROM oauth_refresh_tokens WHERE token_hash=$1`, rotation.RefreshHash).Scan(&refreshExpires))
	if !refreshExpires.Equal(rotation.GrantExpiresAt) || !refreshExpires.After(issue.Grant.CreatedAt.Add(30*24*time.Hour)) {
		t.Fatalf("rolling deadline: %v", refreshExpires)
	}
}

func TestAPIReaderRequiresPersistedUserAndExpiredFamilyIsRejected(t *testing.T) {
	tx, dao := transaction(t)
	ctx, now := context.Background(), time.Now().UTC().Truncate(time.Microsecond)
	issue := apiFamily(now.Add(-30 * time.Minute))
	check(t, dao.IssueFamily(ctx, issue))
	actor := model.Principal{Kind: model.OAuthCredential, UserID: issue.Grant.UserID, CredentialID: issue.AccessID}
	_, err := pg.ThreadCredential(ctx, tx, actor, "")
	missing(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,$3,$3)`, issue.Grant.UserID, uuid.NewString(), now)
	check(t, err)
	// The access token can remain live independently of the shorter family deadline.
	_, err = tx.Exec(ctx, `UPDATE oauth_grants SET expires_at=$2 WHERE id=$1`, issue.Grant.ID, now.Add(-time.Microsecond))
	check(t, err)
	_, err = pg.ThreadCredential(ctx, tx, actor, " FOR SHARE")
	missing(t, err)
}
