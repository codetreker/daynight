package pg_test

import (
	"context"
	"crypto/sha256"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func credentialScopeStore(t *testing.T) (*postgres.Store, model.Principal, string) {
	t.Helper()
	db, err := postgres.Open(t.Context(), testutil.ScopedDatabaseURL(t))
	if err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	t.Cleanup(db.Close)
	user, grant, access := uuid.NewString(), uuid.NewString(), uuid.NewString()
	hash := sha256.Sum256([]byte(access))
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$2,now(),now())`, user, uuid.NewString()); err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO oauth_grants(id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at,business_scopes,scope_version) VALUES($1,$2,'client','{}','https://example.test/mcp','daynight:mcp',now(),now()+interval '1 day',ARRAY['task:read'],1)`, grant, user); err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO oauth_access_tokens(id,grant_id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,$4,now(),now()+interval '30 minutes')`, access, grant, user, hash[:]); err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	return db, model.Principal{Kind: model.OAuthCredential, UserID: user, CredentialID: access}, grant
}

func TestThreadCredentialWaitsForGrantBeforeAccessAndReadsEditedPolicy(t *testing.T) {
	db, principal, grant := credentialScopeStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	editor, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	reader, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	defer func() {
		_ = editor.Rollback(context.Background())
		_ = reader.Rollback(context.Background())
	}()
	if _, err := editor.Exec(ctx, `UPDATE oauth_grants SET business_scopes=ARRAY['project:read'],scope_version=2 WHERE id=$1`, grant); err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	type result struct {
		credential store.ThreadCredential
		err        error
	}
	done := make(chan result, 1)
	finished := false
	defer func() {
		cancel()
		_ = editor.Rollback(context.Background())
		if !finished {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("credential reader did not stop")
			}
		}
	}()
	go func() {
		c, err := pg.ThreadCredential(ctx, reader, principal, " FOR SHARE")
		done <- result{c, err}
	}()
	for {
		var blocked bool
		if err := db.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2::integer))`, int32(editor.Conn().PgConn().PID()), int32(reader.Conn().PgConn().PID())).Scan(&blocked); err != nil {
			t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
		}
		if blocked {
			break
		}
		select {
		case r := <-done:
			finished = true
			t.Fatalf("reader did not wait for grant: %+v", r)
		case <-ctx.Done():
			t.Fatal("reader did not reach grant lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
	// The reader must not lock the access row before it acquires the grant.
	probe, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	if _, err := probe.Exec(ctx, `SELECT id FROM oauth_access_tokens WHERE id=$1 FOR UPDATE NOWAIT`, principal.CredentialID); err != nil {
		_ = probe.Rollback(context.Background())
		t.Fatalf("reader locked access while waiting on grant: %v", err)
	}
	if err := probe.Rollback(ctx); err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	if err := editor.Commit(ctx); err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	select {
	case r := <-done:
		finished = true
		if r.err != nil || r.credential.ScopePolicy == nil || r.credential.ScopePolicy.Kind() != scopepolicy.MCP || r.credential.ScopePolicy.Version() != 2 || !slices.Equal(r.credential.ScopePolicy.Scopes(), []scopepolicy.ScopeID{"project:read"}) {
			t.Fatalf("credential after edit = %+v, %v", r.credential, r.err)
		}
	case <-ctx.Done():
		t.Fatal("reader did not finish after editor committed")
	}
	if err := reader.Commit(ctx); err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
}

func TestThreadCredentialOAuthPolicyValidationAndFixedProfile(t *testing.T) {
	db, principal, grant := credentialScopeStore(t)
	ctx := t.Context()
	check := func(lock string) (store.ThreadCredential, error) {
		t.Helper()
		tx, err := db.Pool.Begin(ctx)
		if err != nil {
			t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
		}
		defer func() { _ = tx.Rollback(context.Background()) }()
		return pg.ThreadCredential(ctx, tx, principal, lock)
	}
	for _, lock := range []string{"", " FOR SHARE"} {
		got, err := check(lock)
		if err != nil || got.ScopePolicy == nil || got.ScopePolicy.Version() != 1 || !slices.Equal(got.ScopePolicy.Scopes(), []scopepolicy.ScopeID{"task:read"}) {
			t.Fatalf("%q scoped credential = %+v, %v", lock, got, err)
		}
	}
	for _, tc := range []struct{ name, sql string }{
		{"missing version", `UPDATE oauth_grants SET business_scopes=ARRAY['task:read'],scope_version=NULL WHERE id=$1`},
		{"missing scopes", `UPDATE oauth_grants SET business_scopes=NULL,scope_version=1 WHERE id=$1`},
		{"invalid version", `UPDATE oauth_grants SET business_scopes=ARRAY['task:read'],scope_version=0 WHERE id=$1`},
		{"unknown scope", `UPDATE oauth_grants SET business_scopes=ARRAY['unknown'],scope_version=1 WHERE id=$1`},
		{"noncanonical scope", `UPDATE oauth_grants SET business_scopes=ARRAY['task:read','project:read'],scope_version=1 WHERE id=$1`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := db.Pool.Exec(ctx, tc.sql, grant); err != nil {
				t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
			}
			for _, lock := range []string{"", " FOR SHARE"} {
				if got, err := check(lock); err == nil {
					t.Fatalf("%q accepted corrupt policy: %+v", lock, got)
				}
			}
		})
	}
	if _, err := db.Pool.Exec(ctx, `UPDATE oauth_grants SET client_id='societas-bot',resource='https://example.test/api/v1',scope='daynight:api',business_scopes=NULL,scope_version=NULL WHERE id=$1`, grant); err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	for _, lock := range []string{"", " FOR SHARE"} {
		got, err := check(lock)
		if err != nil || got.ScopePolicy != nil || got.ExpiresAt == nil {
			t.Fatalf("%q fixed profile = %+v, %v", lock, got, err)
		}
	}
}

func TestThreadCredentialKeepsGrantLockWhileWaitingForAccess(t *testing.T) {
	db, principal, grant := credentialScopeStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	holder, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	reader, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	defer func() {
		_ = holder.Rollback(context.Background())
		_ = reader.Rollback(context.Background())
	}()
	if _, err := holder.Exec(ctx, `SELECT id FROM oauth_access_tokens WHERE id=$1 FOR UPDATE`, principal.CredentialID); err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	done := make(chan error, 1)
	finished := false
	defer func() {
		cancel()
		_ = holder.Rollback(context.Background())
		if !finished {
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Error("credential reader did not stop")
			}
		}
	}()
	go func() {
		_, err := pg.ThreadCredential(ctx, reader, principal, " FOR SHARE")
		done <- err
	}()
	for {
		var blocked bool
		if err := db.Pool.QueryRow(ctx, `SELECT $1::integer=ANY(pg_blocking_pids($2::integer))`, int32(holder.Conn().PgConn().PID()), int32(reader.Conn().PgConn().PID())).Scan(&blocked); err != nil {
			t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
		}
		if blocked {
			break
		}
		select {
		case err := <-done:
			finished = true
			t.Fatalf("reader did not wait for access: %v", err)
		case <-ctx.Done():
			t.Fatal("reader did not reach access lock")
		case <-time.After(10 * time.Millisecond):
		}
	}
	probe, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	_, err = probe.Exec(ctx, `SELECT id FROM oauth_grants WHERE id=$1 FOR UPDATE NOWAIT`, grant)
	_ = probe.Rollback(context.Background())
	var lockErr *pgconn.PgError
	if !errors.As(err, &lockErr) || lockErr.Code != "55P03" {
		t.Fatalf("grant was not locked while waiting for access: %v", err)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
	select {
	case err := <-done:
		finished = true
		if err != nil {
			t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
		}
	case <-ctx.Done():
		t.Fatal("reader did not finish after access released")
	}
	if err := reader.Commit(ctx); err != nil {
		t.Fatalf("error: %v; cause: %+v", err, errors.Unwrap(err))
	}
}
