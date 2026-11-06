package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestOAuthFamilyTransactionAndAdmission(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,$3,$3)`, user, uuid.NewString(), now); err != nil {
		t.Fatal(err)
	}
	access, refresh := secret.Random("dnmcp_"), secret.Random("dnmcr_")
	issue := store.OAuthFamilyIssue{
		Grant:    store.OAuthGrant{ID: uuid.NewString(), UserID: user, ClientID: "client", ClientSnapshot: []byte(`{"name":"client"}`), Resource: "https://example.test/mcp", Scope: "daynight:mcp", CreatedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)},
		AccessID: uuid.NewString(), AccessHash: secret.Hash(access), RefreshHash: secret.Hash(refresh), AccessExpiresAt: now.Add(time.Hour),
	}
	abort := errors.New("abort")
	completion, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		if err := scope.CredentialFamilyDAO().IssueFamily(ctx, issue); err != nil {
			return err
		}
		return abort
	})
	if !errors.Is(err, abort) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %+v %v", completion, err)
	}
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants)+(SELECT count(*) FROM oauth_access_tokens)+(SELECT count(*) FROM oauth_refresh_tokens)`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("rollback rows = %d, %v", count, err)
	}
	completion, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		return scope.CredentialFamilyDAO().IssueFamily(ctx, issue)
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("issue: %+v %v", completion, err)
	}
	var storedAccess, storedRefresh []byte
	if err := db.Pool.QueryRow(ctx, `SELECT a.token_hash,r.token_hash FROM oauth_access_tokens a JOIN oauth_refresh_tokens r ON r.grant_id=a.grant_id WHERE a.id=$1`, issue.AccessID).Scan(&storedAccess, &storedRefresh); err != nil || string(storedAccess) != string(secret.Hash(access)) || string(storedRefresh) != string(secret.Hash(refresh)) {
		t.Fatalf("stored hashes: %v", err)
	}
	_, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		dao := scope.CredentialFamilyDAO()
		identity, err := dao.AuthenticateAccess(ctx, secret.Hash(access), issue.Grant.Resource, issue.Grant.Scope, now)
		if err != nil || identity.Principal.UserID != user || identity.Principal.CredentialID != issue.AccessID || identity.Principal.Kind != model.OAuthCredential || identity.GrantID != issue.Grant.ID {
			t.Fatalf("authenticate: %+v %v", identity, err)
		}
		for _, input := range []struct {
			hash            []byte
			resource, scope string
			at              time.Time
		}{
			{secret.Hash(refresh), issue.Grant.Resource, issue.Grant.Scope, now},
			{secret.Hash(access), "https://other/mcp", issue.Grant.Scope, now},
			{secret.Hash(access), issue.Grant.Resource, "other", now},
			{secret.Hash(access), issue.Grant.Resource, issue.Grant.Scope, issue.AccessExpiresAt},
		} {
			if _, err := dao.AuthenticateAccess(ctx, input.hash, input.resource, input.scope, input.at); !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("unexpected admission: %v", err)
			}
		}
		grant, err := dao.InspectGrant(ctx, issue.Grant.ID, false)
		if err != nil || grant.UserID != user || grant.ClientID != "client" || grant.RevokedAt != nil {
			t.Fatalf("grant: %+v %v", grant, err)
		}
		active, err := dao.ActiveClientReferences(ctx, "client", now)
		if err != nil || !active {
			t.Fatalf("reference: %v %v", active, err)
		}
		active, err = dao.ActiveClientReferences(ctx, "other", now)
		if err != nil || active {
			t.Fatalf("other reference: %v %v", active, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		changed, err := scope.CredentialFamilyDAO().RevokeFamily(ctx, issue.Grant.ID, now)
		if err != nil || !changed {
			t.Fatalf("revoke: %v %v", changed, err)
		}
		return abort
	})
	if !errors.Is(err, abort) {
		t.Fatalf("rollback revoke: %v", err)
	}
	_, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		dao := scope.CredentialFamilyDAO()
		if _, err := dao.AuthenticateAccess(ctx, secret.Hash(access), issue.Grant.Resource, issue.Grant.Scope, now); err != nil {
			t.Fatal(err)
		}
		changed, err := dao.RevokeFamily(ctx, issue.Grant.ID, now)
		if err != nil || !changed {
			t.Fatalf("revoke: %v %v", changed, err)
		}
		changed, err = dao.RevokeFamily(ctx, issue.Grant.ID, now)
		if err != nil || changed {
			t.Fatalf("repeat revoke: %v %v", changed, err)
		}
		if _, err := dao.AuthenticateAccess(ctx, secret.Hash(access), issue.Grant.Resource, issue.Grant.Scope, now); !errors.Is(err, model.ErrNotFound) {
			t.Fatalf("revoked admitted: %v", err)
		}
		active, err := dao.ActiveClientReferences(ctx, "client", now)
		if err != nil || active {
			t.Fatalf("revoked reference: %v %v", active, err)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_access_tokens), (SELECT count(*) FROM oauth_refresh_tokens)`).Scan(&count, new(int)); err != nil || count != 0 {
		t.Fatalf("access after revoke: %d %v", count, err)
	}
}

func TestOAuthFamilyRejectsInvalidLifetimes(t *testing.T) {
	ctx := context.Background()
	db := isolatedStore(t)
	now := time.Now().UTC().Truncate(time.Microsecond)
	valid := store.OAuthFamilyIssue{Grant: store.OAuthGrant{ID: uuid.NewString(), UserID: uuid.NewString(), ClientID: "c", ClientSnapshot: []byte(`{}`), Resource: "r", Scope: "daynight:mcp", CreatedAt: now, ExpiresAt: now.Add(time.Hour)}, AccessID: uuid.NewString(), AccessHash: make([]byte, 32), RefreshHash: make([]byte, 32), AccessExpiresAt: now.Add(time.Minute)}
	for _, modify := range []func(*store.OAuthFamilyIssue){
		func(v *store.OAuthFamilyIssue) { v.AccessHash = nil },
		func(v *store.OAuthFamilyIssue) { v.RefreshHash = nil },
		func(v *store.OAuthFamilyIssue) { v.AccessExpiresAt = now.Add(2 * time.Hour) },
		func(v *store.OAuthFamilyIssue) { v.Grant.ExpiresAt = now.Add(31 * 24 * time.Hour) },
		func(v *store.OAuthFamilyIssue) { v.Grant.RevokedAt = &now },
	} {
		issue := valid
		modify(&issue)
		_, err := db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
			return scope.CredentialFamilyDAO().IssueFamily(ctx, issue)
		})
		if err == nil {
			t.Fatal("invalid issue accepted")
		}
	}
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM oauth_grants`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("invalid issue persisted: %d %v", count, err)
	}
}

// A calendar-day interval varies across DST when the database session is not UTC.
func TestOAuthFamilyGrantLifetimeAcrossDST(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	db := isolatedStore(t)
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SET LOCAL TIME ZONE 'America/New_York'`); err != nil {
		t.Fatal(err)
	}
	created := time.Date(2026, time.March, 1, 12, 0, 0, 0, time.UTC)
	issue := store.OAuthFamilyIssue{
		Grant:    store.OAuthGrant{ID: uuid.NewString(), UserID: uuid.NewString(), ClientID: "client", ClientSnapshot: []byte(`{}`), Resource: "https://example.test/mcp", Scope: "daynight:mcp", CreatedAt: created, ExpiresAt: created.Add(30 * 24 * time.Hour)},
		AccessID: uuid.NewString(), AccessHash: make([]byte, 32), RefreshHash: make([]byte, 32), AccessExpiresAt: created.Add(time.Hour),
	}
	if err := oauth.NewDAO(tx).IssueFamily(ctx, issue); err != nil {
		t.Fatalf("issue across DST: %v", err)
	}
	var expires time.Time
	if err := tx.QueryRow(ctx, `SELECT expires_at FROM oauth_grants WHERE id=$1`, issue.Grant.ID).Scan(&expires); err != nil || !expires.Equal(issue.Grant.ExpiresAt) {
		t.Fatalf("expiry: %v %v", expires, err)
	}
}
