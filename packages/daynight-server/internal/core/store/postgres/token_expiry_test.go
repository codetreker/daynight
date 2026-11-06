package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	. "github.com/codetreker/daynight/packages/daynight-server/internal/core/store"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func storeTokenExpiry(value time.Time) *time.Time { return &value }

func TestOptionalTokenExpiryMigrationPreservesHistoryAndSessionContract(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:18]); err != nil {
		t.Fatal(err)
	}
	s := &Store{Pool: pool}
	now := time.Now().UTC().Truncate(time.Microsecond)
	user, session := identitySession(uuid.NewString(), "historical:"+uuid.NewString())
	mustQueryExec(t, s, `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,$3,$3)`, user.ID, user.UniAuthID, now)
	mustQueryExec(t, s, `INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5)`, session.ID, user.ID, session.TokenHash, session.CreatedAt, session.ExpiresAt)
	p := model.Principal{Kind: model.SessionCredential, UserID: user.ID, CredentialID: session.ID}
	finite := deviceStoreCredential(now)
	finite.ExpiresAt = storeTokenExpiry(now.Add(30 * 24 * time.Hour))
	finite.UserID = p.UserID
	if err := testIdentityWrite(s, ctx, func(scope IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, finite) }); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := pool.QueryRow(ctx, `SELECT row_to_json(p)::text FROM personal_access_tokens p WHERE id=$1`, finite.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := pool.QueryRow(ctx, `SELECT row_to_json(p)::text FROM personal_access_tokens p WHERE id=$1`, finite.ID).Scan(&after); err != nil || after != before {
		t.Fatalf("optional expiry changed historical credential: %v", err)
	}
	var patRequired, sessionRequired bool
	if err := pool.QueryRow(ctx, `SELECT (SELECT attnotnull FROM pg_attribute WHERE attrelid='personal_access_tokens'::regclass AND attname='expires_at'),(SELECT attnotnull FROM pg_attribute WHERE attrelid='sessions'::regclass AND attname='expires_at')`).Scan(&patRequired, &sessionRequired); err != nil || patRequired || !sessionRequired {
		t.Fatalf("expiry schema boundaries: PAT=%t session=%t %v", patRequired, sessionRequired, err)
	}
	never := deviceStoreCredential(now)
	never.UserID = p.UserID
	if err := testIdentityWrite(s, ctx, func(scope IdentityScope) error { return scope.IdentityDAO().InsertPAT(ctx, never) }); err != nil {
		t.Fatal(err)
	}
	future := now.Add(365 * 24 * time.Hour)
	if _, err := testAuthenticate(s, ctx, model.PATCredential, never.TokenHash, future); err != nil {
		t.Fatalf("nonexpiring token expired: %v", err)
	}
	if _, err := testAuthenticate(s, ctx, model.PATCredential, finite.TokenHash, future); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("historical finite expiry lost: %v", err)
	}
	if _, err := testAuthenticate(s, ctx, model.SessionCredential, session.TokenHash, session.ExpiresAt); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("session became nonexpiring: %v", err)
	}
	if err := testIdentityWrite(s, ctx, func(scope IdentityScope) error { return scope.IdentityDAO().CleanupCredentials(ctx, future) }); err != nil {
		t.Fatal(err)
	}
	if _, err := testAuthenticate(s, ctx, model.PATCredential, never.TokenHash, future); err != nil {
		t.Fatalf("cleanup deleted nonexpiring token: %v", err)
	}
}
