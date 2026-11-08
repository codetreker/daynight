package postgres

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

func lifecycleIssue(t *testing.T, db *Store, user string, now time.Time) (store.OAuthGrant, string, string) {
	t.Helper()
	access, refresh := secret.Random(model.OAuthAccessPrefix), secret.Random(core.RefreshPrefix)
	grant := store.OAuthGrant{ID: uuid.NewString(), UserID: user, ClientID: "client", ClientSnapshot: []byte(`{"clientName":"client"}`), Resource: "https://example.test/mcp", Scope: core.Scope, CreatedAt: now, ExpiresAt: now.Add(core.GrantLifetime)}
	c, err := db.WriteCredentialFamily(t.Context(), func(s store.CredentialFamilyScope) error {
		return s.CredentialFamilyDAO().IssueFamily(t.Context(), store.OAuthFamilyIssue{Grant: grant, AccessID: uuid.NewString(), AccessHash: secret.Hash(access), RefreshHash: secret.Hash(refresh), AccessExpiresAt: now.Add(core.AccessLifetime)})
	})
	if err != nil || c.Outcome != store.TransactionCommitted {
		t.Fatalf("issue: %v %v", c, err)
	}
	return grant, access, refresh
}
func admit(context.Context, string) error { return nil }
func addLifecycleUser(t *testing.T, db *Store) string {
	t.Helper()
	user := uuid.NewString()
	if _, err := db.Pool.Exec(t.Context(), `INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$2,now(),now())`, user, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	return user
}
func TestGrantLifecycleConcurrentReplayAndBinding(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant, access, refresh := lifecycleIssue(t, db, user, now)
	lifecycle := core.NewGrantLifecycle(db)
	for _, x := range []struct{ client, resource string }{{"other", grant.Resource}, {"client", "https://other.test/mcp"}} {
		called := false
		_, err := lifecycle.Rotate(ctx, refresh, x.client, x.resource, func(context.Context, string) error { called = true; return nil })
		if !errors.Is(err, core.ErrInvalidGrant) || called {
			t.Fatalf("binding admitted: %v %v", err, called)
		}
	}
	denied := errors.New("admission denied")
	if _, err := lifecycle.Rotate(ctx, refresh, "client", grant.Resource, func(context.Context, string) error { return denied }); !errors.Is(err, denied) {
		t.Fatalf("admission error: %v", err)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	type reply struct {
		tokens core.RotatedTokens
		err    error
	}
	results := make(chan reply, 2)
	for range 2 {
		go func() {
			defer wg.Done()
			tokens, err := lifecycle.Rotate(ctx, refresh, "client", grant.Resource, admit)
			results <- reply{tokens, err}
		}()
	}
	wg.Wait()
	close(results)
	successes, failures := 0, 0
	var newAccess string
	for r := range results {
		if r.err == nil {
			successes++
			newAccess = r.tokens.AccessToken
			if r.tokens.RefreshToken == "" || r.tokens.ExpiresIn <= 0 {
				t.Fatal("missing rotated tokens")
			}
		} else if errors.Is(r.err, core.ErrInvalidGrant) {
			failures++
		} else {
			t.Fatal(r.err)
		}
	}
	if successes != 1 || failures != 1 {
		t.Fatalf("outcomes success=%d failure=%d", successes, failures)
	}
	for _, token := range []string{access, newAccess} {
		_, err := db.WriteCredentialFamily(ctx, func(s store.CredentialFamilyScope) error {
			_, e := core.AuthenticateAccess(ctx, s.CredentialFamilyDAO(), token, grant.Resource, time.Now())
			return e
		})
		if err == nil {
			t.Fatal("revoked access authenticated")
		}
	}
	var revoked bool
	var accesses int
	if err := db.Pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL,(SELECT count(*) FROM oauth_access_tokens WHERE grant_id=$1) FROM oauth_grants WHERE id=$1`, grant.ID).Scan(&revoked, &accesses); err != nil || !revoked || accesses != 0 {
		t.Fatalf("replay not committed: %v %d %v", revoked, accesses, err)
	}
}

func TestGrantLifecyclePublicOwnerAndExpiry(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user, other := addLifecycleUser(t, db), addLifecycleUser(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant, access, refresh := lifecycleIssue(t, db, user, now)
	lifecycle := core.NewGrantLifecycle(db)
	if err := lifecycle.RevokePublic(ctx, access, "wrong"); err != nil {
		t.Fatal(err)
	}
	if _, err := lifecycle.RevokeOwnerGrant(ctx, other, grant.ID); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("foreign owner: %v", err)
	}
	list, err := lifecycle.ListOwnerGrants(ctx, user)
	if err != nil || len(list) != 1 || list[0].ID != grant.ID {
		t.Fatalf("owner list: %+v %v", list, err)
	}
	rotated, err := lifecycle.Rotate(ctx, refresh, "client", grant.Resource, admit)
	if err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.RevokePublic(ctx, rotated.RefreshToken, "client"); err != nil {
		t.Fatal(err)
	}
	changed, err := lifecycle.RevokeOwnerGrant(ctx, user, grant.ID)
	if err != nil || changed {
		t.Fatalf("repeat revoke: %v %v", changed, err)
	}
	if err := lifecycle.RevokePublic(ctx, "unknown", "client"); err != nil {
		t.Fatal(err)
	}
	if _, err := lifecycle.Rotate(ctx, rotated.RefreshToken, "client", grant.Resource, admit); !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("revoked refresh: %v", err)
	}
	expired, _, expiredRefresh := lifecycleIssue(t, db, user, now.Add(-31*24*time.Hour))
	if _, err := lifecycle.Rotate(ctx, expiredRefresh, "client", expired.Resource, admit); !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("expired refresh: %v", err)
	}
	n, err := lifecycle.PruneCredentials(ctx, 1)
	if err != nil || n != 1 {
		t.Fatalf("bounded cleanup: %d %v", n, err)
	}
	if _, err := lifecycle.PruneCredentials(ctx, 2000); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM oauth_refresh_tokens WHERE grant_id=$1`, expired.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("expired refresh retained: %d %v", count, err)
	}
}

type unknownLifecycle struct {
	store.GrantLifecycleWriter
	calls int
}

func (w *unknownLifecycle) WriteGrantLifecycle(ctx context.Context, fn func(store.GrantLifecycleDAO) error) (store.Completion, error) {
	c, err := w.GrantLifecycleWriter.WriteGrantLifecycle(ctx, fn)
	if err != nil {
		return c, err
	}
	w.calls++
	if w.calls == 1 {
		return c, nil
	}
	return store.Completion{Outcome: store.TransactionUnknown}, errors.New("lost commit response")
}
func TestGrantLifecycleUnknownDoesNotReturnSecrets(t *testing.T) {
	db := isolatedStore(t)
	user := addLifecycleUser(t, db)
	grant, _, refresh := lifecycleIssue(t, db, user, time.Now().UTC().Truncate(time.Microsecond))
	lifecycle := core.NewGrantLifecycle(&unknownLifecycle{GrantLifecycleWriter: db})
	result, err := lifecycle.Rotate(t.Context(), refresh, "client", grant.Resource, admit)
	if !errors.Is(err, core.ErrAuthorizationUnknown) || result.AccessToken != "" || result.RefreshToken != "" {
		t.Fatalf("unknown result exposed token: %+v %v", result, err)
	}
	normal := core.NewGrantLifecycle(db)
	if _, err := normal.Rotate(t.Context(), refresh, "client", grant.Resource, admit); !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("replay: %v", err)
	}
}

func TestGrantLifecycleWaitRechecksExpiry(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	grant, _, refresh := lifecycleIssue(t, db, user, time.Now().UTC().Truncate(time.Microsecond))
	tx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT 1 FROM oauth_grants WHERE id=$1 FOR UPDATE`, grant.ID); err != nil {
		t.Fatal(err)
	}
	lifecycle := core.NewGrantLifecycle(db)
	done := make(chan error, 1)
	go func() { _, err := lifecycle.Rotate(ctx, refresh, "client", grant.Resource, admit); done <- err }()
	waitTransferTeamLock(t, ctx, db, "SELECT id::text,user_id::text,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at FROM oauth_grants", tx.Conn().PgConn().PID())
	var expiry time.Time
	if err = tx.QueryRow(ctx, `UPDATE oauth_grants SET expires_at=clock_timestamp()+interval '20 milliseconds' WHERE id=$1 RETURNING expires_at`, grant.ID).Scan(&expiry); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.005)`, expiry); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("expired while waiting: %v", err)
	}
	var consumed bool
	if err := db.Pool.QueryRow(ctx, `SELECT consumed_at IS NOT NULL FROM oauth_refresh_tokens WHERE token_hash=$1`, secret.Hash(refresh)).Scan(&consumed); err != nil || consumed {
		t.Fatalf("expired refresh consumed: %v %v", consumed, err)
	}
}

func TestGrantLifecycleAccessRevokeAndOwnerRevoke(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant, access, refresh := lifecycleIssue(t, db, user, now)
	lifecycle := core.NewGrantLifecycle(db)
	if err := lifecycle.RevokePublic(ctx, access, "client"); err != nil {
		t.Fatal(err)
	}
	if _, err := lifecycle.Rotate(ctx, refresh, "client", grant.Resource, admit); !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("access revocation left refresh usable: %v", err)
	}
	second, _, secondRefresh := lifecycleIssue(t, db, user, now)
	changed, err := lifecycle.RevokeOwnerGrant(ctx, user, second.ID)
	if err != nil || !changed {
		t.Fatalf("owner revoke: %v %v", changed, err)
	}
	if _, err := lifecycle.Rotate(ctx, secondRefresh, "client", second.Resource, admit); !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("owner revocation left refresh usable: %v", err)
	}
}

func TestGrantLifecycleAdmissionDoesNotExhaustPool(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant1, _, refresh1 := lifecycleIssue(t, db, user, now)
	grant2, _, refresh2 := lifecycleIssue(t, db, user, now)
	config := db.Pool.Config()
	config.MaxConns = 2
	config.MinConns = 0
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	limited := &Store{Pool: pool}
	lifecycle := core.NewGrantLifecycle(limited)
	admission := core.PublicAdmission{Writer: limited}
	permit1, ok, err := admission.TakeToken(ctx, "pool-source-1")
	if err != nil || !ok {
		t.Fatalf("permit: %v", err)
	}
	permit2, ok, err := admission.TakeToken(ctx, "pool-source-2")
	if err != nil || !ok {
		t.Fatalf("permit: %v", err)
	}
	ready := make(chan struct{}, 2)
	release := make(chan struct{})
	done := make(chan error, 2)
	for _, req := range []struct {
		grant   store.OAuthGrant
		refresh string
		permit  *core.TokenPermit
	}{{grant1, refresh1, permit1}, {grant2, refresh2, permit2}} {
		go func() {
			_, err := lifecycle.Rotate(ctx, req.refresh, "client", req.grant.Resource, func(ctx context.Context, id string) error {
				ready <- struct{}{}
				select {
				case <-release:
				case <-ctx.Done():
					return ctx.Err()
				}
				ok, err := req.permit.TakeClient(ctx, id)
				if err != nil {
					return err
				}
				if !ok {
					return core.ErrRateLimited
				}
				return nil
			})
			done <- err
		}()
	}
	for range 2 {
		select {
		case <-ready:
		case <-ctx.Done():
			t.Fatal("rotations did not reach admission")
		}
	}
	close(release)
	for range 2 {
		if err := <-done; err != nil {
			t.Fatalf("rotation with two-connection pool: %v", err)
		}
	}
}

func TestGrantLifecycleCleanupFairAcrossOneRowBatches(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	for range 4 {
		lifecycleIssue(t, db, user, now.Add(-62*24*time.Hour))
	}
	for range 3 {
		// A new lifecycle simulates independent instances and restart.
		n, err := core.NewGrantLifecycle(db).PruneCredentials(ctx, 1)
		if err != nil || n != 1 {
			t.Fatalf("cleanup: %d %v", n, err)
		}
	}
	var grants, access, refresh int
	if err := db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants),(SELECT count(*) FROM oauth_access_tokens),(SELECT count(*) FROM oauth_refresh_tokens)`).Scan(&grants, &access, &refresh); err != nil {
		t.Fatal(err)
	}
	if grants != 3 || access != 3 || refresh != 3 {
		t.Fatalf("cleanup unfair: grants=%d access=%d refresh=%d", grants, access, refresh)
	}
}

func TestGrantLifecycleReplayWaitsForBusinessCredentialLocks(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	grant, access, refresh := lifecycleIssue(t, db, user, time.Now().UTC().Truncate(time.Microsecond))
	lifecycle := core.NewGrantLifecycle(db)
	if _, err := lifecycle.Rotate(ctx, refresh, "client", grant.Resource, admit); err != nil {
		t.Fatal(err)
	}
	var credentialID string
	if err := db.Pool.QueryRow(ctx, `SELECT id::text FROM oauth_access_tokens WHERE token_hash=$1`, secret.Hash(access)).Scan(&credentialID); err != nil {
		t.Fatal(err)
	}
	principal := model.Principal{Kind: model.OAuthCredential, UserID: user, CredentialID: credentialID}
	threadTx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer threadTx.Rollback(context.Background())
	botTx, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer botTx.Rollback(context.Background())
	if _, err = (&ThreadTx{tx: threadTx}).CredentialDAO().Credential(ctx, principal); err != nil {
		t.Fatal(err)
	}
	if err = botpg.NewWriter(botTx).Credential(ctx, principal); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := lifecycle.Rotate(ctx, refresh, "client", grant.Resource, admit); done <- err }()
	waitForDelete := func() {
		t.Helper()
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			var waiting bool
			err := db.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=current_setting('application_name') AND wait_event_type='Lock' AND query LIKE 'DELETE FROM oauth_access_tokens%')`).Scan(&waiting)
			if err != nil {
				t.Fatal(err)
			}
			if waiting {
				return
			}
			select {
			case err := <-done:
				t.Fatalf("replay returned before credential locks released: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-ticker.C:
			}
		}
	}
	waitForDelete()
	if err = threadTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	waitForDelete()
	if err = botTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-done; !errors.Is(err, core.ErrInvalidGrant) {
		t.Fatalf("replay: %v", err)
	}
	_, err = db.WriteThread(ctx, func(scope store.ThreadScope) error {
		_, e := scope.CredentialDAO().Credential(ctx, principal)
		return e
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("thread credential accepted: %v", err)
	}
	_, err = db.WriteBot(ctx, func(scope store.BotScope) error { return scope.BotDAO().Credential(ctx, principal) })
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("bot credential accepted: %v", err)
	}
}

func TestAuthorizationCleanupFairAcrossOneRowBatches(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	now := time.Now().UTC()
	for range 4 {
		for _, status := range []string{"pending", "denied"} {
			retain := now.Add(time.Hour)
			if status == "denied" {
				retain = now.Add(-time.Hour)
			}
			_, err := db.Pool.Exec(ctx, `INSERT INTO oauth_authorizations (id,binding_hash,client_snapshot,client_id,redirect_uri,resource,scope,challenge,state,state_present,status,created_at,expires_at,retain_until) VALUES ($1,$2,'{}','client','https://client.test/callback','https://server.test/mcp','daynight:mcp','challenge','',false,$3,$4,$5,$6)`, uuid.NewString(), make([]byte, 32), status, now.Add(-2*time.Hour), now.Add(-time.Hour), retain)
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	for range 2 {
		count := 0
		c, err := db.WriteAuthorizations(ctx, func(scope store.AuthorizationScope) error {
			var e error
			count, e = core.PruneAuthorizationBatch(ctx, scope.AuthorizationDAO(), now, 1)
			return e
		})
		if err != nil || c.Outcome != store.TransactionCommitted || count != 1 {
			t.Fatalf("prune: %d %v %v", count, c, err)
		}
	}
	var pending, expired, denied int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FILTER (WHERE status='pending'),count(*) FILTER (WHERE status='expired'),count(*) FILTER (WHERE status='denied') FROM oauth_authorizations`).Scan(&pending, &expired, &denied); err != nil {
		t.Fatal(err)
	}
	if pending != 3 || expired != 1 || denied != 3 {
		t.Fatalf("unfair pruning: pending=%d expired=%d denied=%d", pending, expired, denied)
	}
}
