package oauth_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	botpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/bot"
	oauthpg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func lifecycleIssue(t *testing.T, db *postgres.Store, user string, now time.Time) (store.OAuthGrant, string, string) {
	return testutil.OAuthFamily(t, db, user, now)
}
func addLifecycleUser(t *testing.T, db *postgres.Store) string {
	return testutil.AddOAuthUser(t, db.Pool)
}

func rotateFamilyForTest(t *testing.T, ctx context.Context, db *postgres.Store, grant store.OAuthGrant, hash []byte) error {
	t.Helper()
	_, err := db.WriteGrantLifecycle(ctx, func(dao store.GrantLifecycleDAO) error {
		locked, err := dao.InspectGrant(ctx, grant.ID, true)
		if err != nil {
			return err
		}
		previous, err := dao.Refresh(ctx, hash, true)
		if err != nil {
			return err
		}
		if previous.ConsumedAt != nil {
			return errors.New("fixture refresh already consumed")
		}
		now, err := dao.FreshTime(ctx, time.Now().UTC())
		if err != nil {
			return err
		}
		return dao.RotateRefresh(ctx, store.OAuthRotation{Grant: locked, OldHash: hash, AccessHash: secret.Hash(uuid.NewString()), RefreshHash: secret.Hash(uuid.NewString()), AccessID: uuid.NewString(), CreatedAt: now, AccessExpiresAt: now.Add(time.Hour), GrantExpiresAt: locked.ExpiresAt})
	})
	return err
}

func TestGrantLifecycleReplayWaitsForBusinessCredentialLocks(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	grant, access, refresh := lifecycleIssue(t, db, user, time.Now().UTC().Truncate(time.Microsecond))
	if err := rotateFamilyForTest(t, ctx, db, grant, secret.Hash(refresh)); err != nil {
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
	if _, err := task.NewThreadDAO(threadTx).Credential(ctx, principal); err != nil {
		t.Fatal(err)
	}
	if err := botpg.NewWriter(botTx).Credential(ctx, principal); err != nil {
		t.Fatal(err)
	}
	revoker, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer revoker.Rollback(context.Background())
	revoked, revokedDone := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(revokedDone)
		changed, err := oauthpg.NewDAO(revoker).RevokeFamily(ctx, grant.ID, time.Now())
		if err == nil && !changed {
			err = errors.New("active family was not revoked")
		}
		revoked <- err
	}()
	defer func() {
		cancel()
		_ = threadTx.Rollback(context.Background())
		_ = botTx.Rollback(context.Background())
		select {
		case <-revokedDone:
		case <-time.After(2 * time.Second):
			t.Error("family revocation did not drain")
		}
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "DELETE FROM oauth_access_tokens", threadTx.Conn().PgConn().PID())
	if err := threadTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "DELETE FROM oauth_access_tokens", botTx.Conn().PgConn().PID())
	if err := botTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-revoked:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	waiting, finished := make(chan error, 2), make(chan struct{}, 2)
	go func() {
		defer func() { finished <- struct{}{} }()
		_, err := db.WriteThread(ctx, func(scope store.ThreadScope) error {
			_, err := scope.CredentialDAO().Credential(ctx, principal)
			return err
		})
		waiting <- err
	}()
	go func() {
		defer func() { finished <- struct{}{} }()
		_, err := db.WriteBot(ctx, func(scope store.BotScope) error { return scope.BotDAO().Credential(ctx, principal) })
		waiting <- err
	}()
	defer func() {
		cancel()
		_ = revoker.Rollback(context.Background())
		for range 2 {
			select {
			case <-finished:
			case <-time.After(2 * time.Second):
				t.Error("business credential waiter did not drain")
			}
		}
	}()
	for {
		var count int
		if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=current_schema() AND wait_event_type='Lock' AND query LIKE 'SELECT LEAST(a.expires_at,g.expires_at) FROM oauth_access_tokens%' AND $1=ANY(pg_blocking_pids(pid))`, revoker.Conn().PgConn().PID()).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count == 2 {
			break
		}
		select {
		case err := <-waiting:
			t.Fatalf("business credential returned before revocation commit: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		default:
		}
		if err := testutil.WaitThreadClock(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if err := revoker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		select {
		case err := <-waiting:
			if !errors.Is(err, model.ErrNotFound) {
				t.Fatalf("committed family revocation accepted credential: %v", err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	_, err = db.WriteGrantLifecycle(ctx, func(dao store.GrantLifecycleDAO) error {
		current, err := dao.Refresh(ctx, secret.Hash(refresh), false)
		if err != nil {
			return err
		}
		if current.ConsumedAt == nil {
			return errors.New("replayed refresh lost consumption")
		}
		revoked, err := dao.InspectGrant(ctx, grant.ID, false)
		if err == nil && revoked.RevokedAt == nil {
			return errors.New("family retained no revocation")
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.WriteCredentialFamily(ctx, func(scope store.CredentialFamilyScope) error {
		_, err := scope.CredentialFamilyDAO().AuthenticateAccess(ctx, secret.Hash(access), []store.OAuthBinding{{Resource: grant.Resource, Scope: grant.Scope}}, time.Now())
		return err
	})
	if !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("access survived family revocation: %v", err)
	}
	var active int
	if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM oauth_access_tokens WHERE grant_id=$1`, grant.ID).Scan(&active); err != nil || active != 0 {
		t.Fatalf("revoked family retained access rows: %d %v", active, err)
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
		var n int
		_, err := (&postgres.Store{Pool: db.Pool}).WriteGrantLifecycle(ctx, func(dao store.GrantLifecycleDAO) error {
			var err error
			n, err = dao.PruneCredentials(ctx, now, 1)
			return err
		})
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

func TestGrantLifecycleConcurrentReplayAndBinding(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant, access, refresh := lifecycleIssue(t, db, user, now)
	first, err := db.Pool.Begin(ctx)
	check(t, err)
	defer first.Rollback(context.Background())
	firstDAO := oauthpg.NewDAO(first)
	locked, err := firstDAO.InspectGrant(ctx, grant.ID, true)
	check(t, err)
	current, err := firstDAO.Refresh(ctx, secret.Hash(refresh), true)
	check(t, err)
	if current.GrantID != grant.ID || current.ClientID != "client" || current.ConsumedAt != nil {
		t.Fatalf("refresh binding: %#v", current)
	}
	newAccess, newRefresh := secret.Hash("rotated-access"), secret.Hash("rotated-refresh")
	check(t, firstDAO.RotateRefresh(ctx, store.OAuthRotation{Grant: locked, OldHash: secret.Hash(refresh), AccessHash: newAccess, RefreshHash: newRefresh, AccessID: uuid.NewString(), CreatedAt: now, AccessExpiresAt: now.Add(time.Hour), GrantExpiresAt: locked.ExpiresAt}))
	second, err := db.Pool.Begin(ctx)
	check(t, err)
	defer second.Rollback(context.Background())
	done, finished := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(finished)
		dao := oauthpg.NewDAO(second)
		if _, err := dao.InspectGrant(ctx, grant.ID, true); err != nil {
			done <- err
			return
		}
		old, err := dao.Refresh(ctx, secret.Hash(refresh), true)
		if err != nil {
			done <- err
			return
		}
		if old.ConsumedAt == nil {
			done <- errors.New("locked refresh did not observe preceding consumption")
			return
		}
		changed, err := dao.RevokeFamily(ctx, grant.ID, time.Now())
		if err == nil && !changed {
			err = errors.New("replayed family did not revoke")
		}
		if err == nil {
			err = second.Commit(ctx)
		}
		done <- err
	}()
	defer func() {
		cancel()
		_ = first.Rollback(context.Background())
		_ = second.Rollback(context.Background())
		select {
		case <-finished:
		case <-time.After(2 * time.Second):
			t.Error("replay waiter did not drain")
		}
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text,user_id::text,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at,last_used_at FROM oauth_grants", first.Conn().PgConn().PID())
	check(t, first.Commit(ctx))
	check(t, testutil.ReceiveQueryResult(t, ctx, done))
	read, err := db.Pool.Begin(ctx)
	check(t, err)
	defer read.Rollback(context.Background())
	for _, hash := range [][]byte{secret.Hash(access), newAccess} {
		_, err := oauthpg.NewDAO(read).AuthenticateAccess(ctx, hash, []store.OAuthBinding{{Resource: grant.Resource, Scope: grant.Scope}}, time.Now())
		missing(t, err)
	}
	var revoked bool
	var accesses int
	check(t, db.Pool.QueryRow(ctx, `SELECT revoked_at IS NOT NULL,(SELECT count(*) FROM oauth_access_tokens WHERE grant_id=$1) FROM oauth_grants WHERE id=$1`, grant.ID).Scan(&revoked, &accesses))
	if !revoked || accesses != 0 {
		t.Fatalf("replay not committed: %v %d", revoked, accesses)
	}
}

func TestGrantLifecycleWaitRechecksExpiry(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	grant, _, refresh := lifecycleIssue(t, db, user, time.Now().UTC().Truncate(time.Microsecond))
	holder, err := db.Pool.Begin(ctx)
	check(t, err)
	defer holder.Rollback(context.Background())
	_, err = holder.Exec(ctx, `SELECT 1 FROM oauth_grants WHERE id=$1 FOR UPDATE`, grant.ID)
	check(t, err)
	waiter, err := db.Pool.Begin(ctx)
	check(t, err)
	defer waiter.Rollback(context.Background())
	done, finished := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(finished)
		dao := oauthpg.NewDAO(waiter)
		locked, err := dao.InspectGrant(ctx, grant.ID, true)
		if err != nil {
			done <- err
			return
		}
		fresh, err := dao.FreshTime(ctx, time.Now())
		if err == nil && locked.ExpiresAt.After(fresh) {
			err = errors.New("locked grant or fresh time retained pre-wait expiry")
		}
		done <- err
	}()
	defer func() {
		cancel()
		_ = holder.Rollback(context.Background())
		_ = waiter.Rollback(context.Background())
		select {
		case <-finished:
		case <-time.After(2 * time.Second):
			t.Error("expiry waiter did not drain")
		}
	}()
	testutil.WaitTransferTeamLock(t, ctx, db.Pool, "SELECT id::text,user_id::text,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at,last_used_at FROM oauth_grants", holder.Conn().PgConn().PID())
	var expiry time.Time
	check(t, holder.QueryRow(ctx, `UPDATE oauth_grants SET expires_at=clock_timestamp()+interval '20 milliseconds' WHERE id=$1 RETURNING expires_at`, grant.ID).Scan(&expiry))
	_, err = holder.Exec(ctx, `SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.005)`, expiry)
	check(t, err)
	check(t, holder.Commit(ctx))
	check(t, testutil.ReceiveQueryResult(t, ctx, done))
	var consumed bool
	check(t, db.Pool.QueryRow(ctx, `SELECT consumed_at IS NOT NULL FROM oauth_refresh_tokens WHERE token_hash=$1`, secret.Hash(refresh)).Scan(&consumed))
	if consumed {
		t.Fatal("expired refresh consumed")
	}
}

func TestExpiredGrantCredentialsPruneWithinRetention(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	user := addLifecycleUser(t, db)
	now := time.Now().UTC().Truncate(time.Microsecond)
	grant, _, _ := lifecycleIssue(t, db, user, now.Add(-31*24*time.Hour))
	var first int
	_, err := db.WriteGrantLifecycle(ctx, func(dao store.GrantLifecycleDAO) error {
		var err error
		first, err = dao.PruneCredentials(ctx, now, 1)
		return err
	})
	check(t, err)
	if first != 1 {
		t.Fatalf("bounded cleanup: %d", first)
	}
	_, err = db.WriteGrantLifecycle(ctx, func(dao store.GrantLifecycleDAO) error {
		_, err := dao.PruneCredentials(ctx, now, 2000)
		return err
	})
	check(t, err)
	var grants, accesses, refreshes int
	check(t, db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM oauth_grants WHERE id=$1),(SELECT count(*) FROM oauth_access_tokens WHERE grant_id=$1),(SELECT count(*) FROM oauth_refresh_tokens WHERE grant_id=$1)`, grant.ID).Scan(&grants, &accesses, &refreshes))
	if grants != 1 || accesses != 0 || refreshes != 0 {
		t.Fatalf("expired credentials or retained metadata: %d/%d/%d", grants, accesses, refreshes)
	}
}
