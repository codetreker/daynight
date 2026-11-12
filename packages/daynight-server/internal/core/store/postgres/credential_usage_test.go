package postgres

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func usageEvent(kind model.UsageSubjectKind, user, id string, at time.Time) model.CredentialUsageEvent {
	return model.CredentialUsageEvent{Kind: kind, UserID: user, SubjectID: id, At: at}
}

func usageWrite(t *testing.T, ctx context.Context, db *Store, events ...model.CredentialUsageEvent) {
	t.Helper()
	slices.SortFunc(events, func(a, b model.CredentialUsageEvent) int {
		return strings.Compare(string(a.Kind)+a.UserID+a.SubjectID, string(b.Kind)+b.UserID+b.SubjectID)
	})
	result, err := db.WriteCredentialUsage(ctx, events)
	if err != nil || result.Outcome != store.TransactionCommitted {
		t.Fatalf("usage write: %+v %v", result, err)
	}
}

func usageSeedPAT(t *testing.T, ctx context.Context, db *Store, user, id string, at time.Time) {
	t.Helper()
	_, err := db.Pool.Exec(ctx, `INSERT INTO personal_access_tokens (id,user_id,token_hash,name,created_at,expires_at) VALUES ($1,$2,decode(replace(($1::uuid)::text,'-','')||replace(($1::uuid)::text,'-',''),'hex'),'fixture',$3,$4)`, id, user, at, at.Add(24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
}
func usageSeedGrant(t *testing.T, ctx context.Context, db *Store, user, id string, at time.Time) {
	t.Helper()
	_, err := db.Pool.Exec(ctx, `INSERT INTO oauth_grants (id,user_id,client_id,client_snapshot,resource,scope,created_at,expires_at,revoked_at) VALUES ($1,$2,'client','{}','resource','scope',$3,$4,$5)`, id, user, at, at.Add(24*time.Hour), at.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
}
func usageRead(t *testing.T, ctx context.Context, db *Store, table, id string) *time.Time {
	t.Helper()
	var value *time.Time
	if err := db.Pool.QueryRow(ctx, `SELECT last_used_at FROM `+pgx.Identifier{table}.Sanitize()+` WHERE id=$1`, id).Scan(&value); err != nil {
		t.Fatal(err)
	}
	return value
}
func usageAssert(t *testing.T, got *time.Time, want *time.Time) {
	t.Helper()
	if (got == nil) != (want == nil) || got != nil && !got.Equal(*want) {
		t.Fatalf("last used = %v, want %v", got, want)
	}
}

func TestCredentialUsagePersistenceAndMetadata(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user, other := uuid.NewString(), uuid.NewString()
	a, b, g, h, newerGrant := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	usageSeedPAT(t, ctx, db, user, a, now)
	usageSeedPAT(t, ctx, db, user, b, now.Add(time.Second))
	usageSeedGrant(t, ctx, db, user, g, now)
	usageSeedGrant(t, ctx, db, user, newerGrant, now.Add(time.Second))
	usageSeedGrant(t, ctx, db, other, h, now)
	usageAssert(t, usageRead(t, ctx, db, "personal_access_tokens", a), nil)
	usageAssert(t, usageRead(t, ctx, db, "oauth_grants", g), nil)
	first, later := now.Add(time.Minute), now.Add(2*time.Minute)
	usageWrite(t, ctx, db, usageEvent(model.UsageSubjectPAT, user, a, first), usageEvent(model.UsageSubjectOAuthGrant, user, g, first), usageEvent(model.UsageSubjectOAuthGrant, other, h, later))
	usageWrite(t, ctx, db, usageEvent(model.UsageSubjectPAT, user, a, later), usageEvent(model.UsageSubjectOAuthGrant, user, g, later))
	usageWrite(t, ctx, db, usageEvent(model.UsageSubjectPAT, user, a, first), usageEvent(model.UsageSubjectOAuthGrant, user, g, later), usageEvent(model.UsageSubjectPAT, other, b, later))
	usageAssert(t, usageRead(t, ctx, db, "personal_access_tokens", a), &later)
	usageAssert(t, usageRead(t, ctx, db, "personal_access_tokens", b), nil)
	usageAssert(t, usageRead(t, ctx, db, "oauth_grants", g), &later)
	usageAssert(t, usageRead(t, ctx, db, "oauth_grants", h), &later)

	completion, err := db.WriteIdentity(ctx, func(sc store.IdentityScope) error {
		dao := sc.IdentityDAO()
		pats, err := dao.ListPATs(ctx, user, now)
		if err != nil {
			return err
		}
		if len(pats) != 2 || pats[0].ID != a || pats[1].ID != b || pats[0].LastUsedAt == nil || !pats[0].LastUsedAt.Equal(later) || pats[1].LastUsedAt != nil {
			return fmt.Errorf("list PATs: %+v", pats)
		}
		locked, err := dao.LockActivePAT(ctx, user, a, now)
		if err != nil {
			return err
		}
		if locked.LastUsedAt == nil || !locked.LastUsedAt.Equal(later) {
			return fmt.Errorf("locked PAT: %+v", locked)
		}
		expiry := now.Add(48 * time.Hour)
		changed, err := dao.SetPATExpiry(ctx, a, &expiry)
		if err != nil {
			return err
		}
		if changed.LastUsedAt == nil || !changed.LastUsedAt.Equal(later) || changed.ExpiresAt == nil || !changed.ExpiresAt.Equal(expiry) {
			return fmt.Errorf("expiry receipt: %+v", changed)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("identity: %+v %v", completion, err)
	}
	completion, err = db.WriteGrantLifecycle(ctx, func(dao store.GrantLifecycleDAO) error {
		grants, err := dao.OwnerGrants(ctx, user)
		if err != nil {
			return err
		}
		if len(grants) != 2 || grants[0].ID != newerGrant || grants[0].LastUsedAt != nil || grants[1].ID != g || grants[1].RevokedAt == nil || grants[1].LastUsedAt == nil || !grants[1].LastUsedAt.Equal(later) {
			return fmt.Errorf("listed grant: %+v", grants)
		}
		grant, err := dao.InspectGrant(ctx, g, false)
		if err != nil {
			return err
		}
		if grant.LastUsedAt == nil || !grant.LastUsedAt.Equal(later) || grant.RevokedAt == nil {
			return fmt.Errorf("inspected grant: %+v", grant)
		}
		return nil
	})
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("grant: %+v %v", completion, err)
	}
	if _, err = db.Pool.Exec(ctx, `DELETE FROM personal_access_tokens WHERE id=$1`, a); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(ctx, `DELETE FROM oauth_grants WHERE id=$1`, g); err != nil {
		t.Fatal(err)
	}
	usageWrite(t, ctx, db, usageEvent(model.UsageSubjectPAT, user, a, later.Add(time.Minute)), usageEvent(model.UsageSubjectOAuthGrant, user, g, later.Add(time.Minute)))
	var count int
	if err = db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM personal_access_tokens WHERE id=$1)+(SELECT count(*) FROM oauth_grants WHERE id=$2)`, a, g).Scan(&count); err != nil || count != 0 {
		t.Fatalf("late write revived deleted rows: %d %v", count, err)
	}
}

// A test-only updatable view gates the second lock query after the first row is
// actually locked. The writer still executes its unchanged SELECT and UPDATE.
func usageGate(t *testing.T, ctx context.Context, db *Store, blockedID string) {
	t.Helper()
	_, err := db.Pool.Exec(ctx, `ALTER TABLE personal_access_tokens RENAME TO usage_pat_rows`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `CREATE FUNCTION usage_gate(id uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$ BEGIN IF id = '`+blockedID+`'::uuid THEN PERFORM pg_advisory_xact_lock(780065); END IF; RETURN true; END $$`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Pool.Exec(ctx, `CREATE VIEW personal_access_tokens AS SELECT * FROM usage_pat_rows WHERE usage_gate(id)`)
	if err != nil {
		t.Fatal(err)
	}
}
func usageWaitBlocked(t *testing.T, ctx context.Context, db *Store, blocker uint32) uint32 {
	t.Helper()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var pid uint32
		err := db.Pool.QueryRow(ctx, `SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) LIMIT 1`, blocker).Scan(&pid)
		if err == nil {
			return pid
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatal(err)
		}
		select {
		case <-ctx.Done():
			t.Fatalf("no blocked backend for %d: %v", blocker, ctx.Err())
		case <-ticker.C:
		}
	}
}

type usageResult struct {
	completion store.Completion
	err        error
}

func TestCredentialUsageNowaitProtectsForeground(t *testing.T) {
	db := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := uuid.NewString()
	a, b := "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"
	usageSeedPAT(t, ctx, db, user, a, now)
	usageSeedPAT(t, ctx, db, user, b, now)
	usageGate(t, ctx, db, b)
	gate, err := db.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Release()
	if _, err = gate.Exec(ctx, `SELECT pg_advisory_lock(780065)`); err != nil {
		t.Fatal(err)
	}
	defer gate.Exec(context.Background(), `SELECT pg_advisory_unlock(780065)`)
	front, err := db.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer front.Rollback(context.Background())
	if _, err = front.Exec(ctx, `SELECT id FROM usage_pat_rows WHERE id=$1 FOR SHARE`, b); err != nil {
		t.Fatal(err)
	}
	events := []model.CredentialUsageEvent{usageEvent(model.UsageSubjectPAT, user, a, now), usageEvent(model.UsageSubjectPAT, user, b, now)}
	result := make(chan usageResult, 1)
	go func() { c, e := db.WriteCredentialUsage(ctx, events); result <- usageResult{c, e} }()
	writerPID := usageWaitBlocked(t, ctx, db, gate.Conn().PgConn().PID())
	foreground := make(chan error, 1)
	go func() {
		_, e := front.Exec(ctx, `SELECT id FROM usage_pat_rows WHERE id=$1 FOR SHARE`, a)
		foreground <- e
	}()
	if pid := usageWaitBlocked(t, ctx, db, writerPID); pid != front.Conn().PgConn().PID() {
		t.Fatalf("wrong foreground waiter %d", pid)
	}
	if _, err = gate.Exec(ctx, `SELECT pg_advisory_unlock(780065)`); err != nil {
		t.Fatal(err)
	}
	var got usageResult
	select {
	case got = <-result:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if got.err == nil || got.completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("NOWAIT completion: %+v %v", got.completion, got.err)
	}
	if failed, state := store.DatabaseErrorFacts(got.err); !failed || state != "55P03" {
		t.Fatalf("NOWAIT SQLSTATE: %q %v", state, got.err)
	}
	select {
	case err = <-foreground:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err = front.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	usageAssert(t, usageRead(t, ctx, db, "usage_pat_rows", a), nil)
	usageAssert(t, usageRead(t, ctx, db, "usage_pat_rows", b), nil)
	usageWrite(t, ctx, db, events...)
	usageAssert(t, usageRead(t, ctx, db, "usage_pat_rows", a), &now)
	usageAssert(t, usageRead(t, ctx, db, "usage_pat_rows", b), &now)
}

func TestCredentialUsageCanceledQueryAndPoolClose(t *testing.T) {
	db := isolatedStore(t)
	ctx, stop := context.WithTimeout(t.Context(), 20*time.Second)
	defer stop()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := uuid.NewString()
	a, b := "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"
	usageSeedPAT(t, ctx, db, user, a, now)
	usageSeedPAT(t, ctx, db, user, b, now)
	usageGate(t, ctx, db, b)
	gate, err := db.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Release()
	if _, err = gate.Exec(ctx, `SELECT pg_advisory_lock(780065)`); err != nil {
		t.Fatal(err)
	}
	defer gate.Exec(context.Background(), `SELECT pg_advisory_unlock(780065)`)
	pool, err := pgxpool.NewWithConfig(ctx, db.Pool.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	writer := &Store{Pool: pool}
	defer writer.Close()
	queryCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	done := make(chan usageResult, 1)
	go func() {
		c, e := writer.WriteCredentialUsage(queryCtx, []model.CredentialUsageEvent{usageEvent(model.UsageSubjectPAT, user, a, now), usageEvent(model.UsageSubjectPAT, user, b, now)})
		done <- usageResult{c, e}
	}()
	usageWaitBlocked(t, ctx, db, gate.Conn().PgConn().PID())
	cancel()
	var result usageResult
	select {
	case result = <-done:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if !errors.Is(result.err, context.Canceled) || result.completion.Outcome != store.TransactionUnknown {
		t.Fatalf("actual query cancellation: %+v %v", result.completion, result.err)
	}
	closed := make(chan struct{})
	go func() { writer.Close(); close(closed) }()
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("pool close did not finish after canceled query")
	}
	usageAssert(t, usageRead(t, ctx, db, "usage_pat_rows", a), nil)
	usageAssert(t, usageRead(t, ctx, db, "usage_pat_rows", b), nil)
	if _, err = gate.Exec(ctx, `SELECT pg_advisory_unlock(780065)`); err != nil {
		t.Fatal(err)
	}
	usageWrite(t, ctx, db, usageEvent(model.UsageSubjectPAT, user, a, now), usageEvent(model.UsageSubjectPAT, user, b, now))
	usageAssert(t, usageRead(t, ctx, db, "usage_pat_rows", a), &now)
}

func TestCredentialUsageConcurrentOlderRetry(t *testing.T) {
	db := isolatedStore(t)
	ctx, stop := context.WithTimeout(t.Context(), 20*time.Second)
	defer stop()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := uuid.NewString()
	a, b := "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"
	usageSeedPAT(t, ctx, db, user, a, now)
	usageSeedPAT(t, ctx, db, user, b, now)
	usageGate(t, ctx, db, b)
	gate, err := db.Pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Release()
	if _, err = gate.Exec(ctx, `SELECT pg_advisory_lock(780065)`); err != nil {
		t.Fatal(err)
	}
	defer gate.Exec(context.Background(), `SELECT pg_advisory_unlock(780065)`)
	newer := now.Add(time.Minute)
	done := make(chan usageResult, 1)
	go func() {
		c, e := db.WriteCredentialUsage(ctx, []model.CredentialUsageEvent{usageEvent(model.UsageSubjectPAT, user, a, newer), usageEvent(model.UsageSubjectPAT, user, b, newer)})
		done <- usageResult{c, e}
	}()
	usageWaitBlocked(t, ctx, db, gate.Conn().PgConn().PID())
	older := usageEvent(model.UsageSubjectPAT, user, a, now)
	c, err := db.WriteCredentialUsage(ctx, []model.CredentialUsageEvent{older})
	if failed, state := store.DatabaseErrorFacts(err); !failed || state != "55P03" || c.Outcome != store.TransactionNotCommitted {
		t.Fatalf("concurrent lock contention: %+v %q %v", c, state, err)
	}
	if _, err = gate.Exec(ctx, `SELECT pg_advisory_unlock(780065)`); err != nil {
		t.Fatal(err)
	}
	select {
	case r := <-done:
		if r.err != nil || r.completion.Outcome != store.TransactionCommitted {
			t.Fatalf("newer write: %+v %v", r.completion, r.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	usageWrite(t, ctx, db, older)
	usageAssert(t, usageRead(t, ctx, db, "usage_pat_rows", a), &newer)
}

func TestCredentialUsagePartialUpdateRollsBack(t *testing.T) {
	db := isolatedStore(t)
	ctx, stop := context.WithTimeout(t.Context(), 20*time.Second)
	defer stop()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user := uuid.NewString()
	a, b := "00000000-0000-0000-0000-000000000001", "00000000-0000-0000-0000-000000000002"
	usageSeedPAT(t, ctx, db, user, a, now)
	usageSeedPAT(t, ctx, db, user, b, now)
	_, err := db.Pool.Exec(ctx, `CREATE FUNCTION reject_second_usage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='`+b+`'::uuid THEN IF NOT EXISTS (SELECT 1 FROM personal_access_tokens WHERE id='`+a+`'::uuid AND last_used_at IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='P1002'; END IF; RAISE EXCEPTION USING ERRCODE='P1001'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_second_usage BEFORE UPDATE ON personal_access_tokens FOR EACH ROW EXECUTE FUNCTION reject_second_usage()`)
	if err != nil {
		t.Fatal(err)
	}
	events := []model.CredentialUsageEvent{usageEvent(model.UsageSubjectPAT, user, a, now), usageEvent(model.UsageSubjectPAT, user, b, now)}
	completion, err := db.WriteCredentialUsage(ctx, events)
	if failed, state := store.DatabaseErrorFacts(err); !failed || state != "P1001" || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("partial write rollback: %+v %q %v", completion, state, err)
	}
	usageAssert(t, usageRead(t, ctx, db, "personal_access_tokens", a), nil)
	usageAssert(t, usageRead(t, ctx, db, "personal_access_tokens", b), nil)
	if _, err = db.Pool.Exec(ctx, `DROP TRIGGER reject_second_usage ON personal_access_tokens; DROP FUNCTION reject_second_usage()`); err != nil {
		t.Fatal(err)
	}
	usageWrite(t, ctx, db, events...)
	usageAssert(t, usageRead(t, ctx, db, "personal_access_tokens", a), &now)
}

func TestCredentialUsageCommitCancellationRemainsUnknown(t *testing.T) {
	db := isolatedStore(t)
	ctx, stop := context.WithTimeout(t.Context(), 20*time.Second)
	defer stop()
	now := time.Now().UTC().Truncate(time.Microsecond)
	user, id := uuid.NewString(), uuid.NewString()
	usageSeedPAT(t, ctx, db, user, id, now)
	commitCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	attempted := false
	traced := taskMutationTracedStore(t, db, taskMutationTrace{match: func(sql string) bool {
		if strings.EqualFold(strings.TrimSpace(sql), "commit") {
			attempted = true
			return true
		}
		return false
	}, cancel: cancel})
	event := usageEvent(model.UsageSubjectPAT, user, id, now)
	completion, err := traced.WriteCredentialUsage(commitCtx, []model.CredentialUsageEvent{event})
	var failure *store.TransactionError
	if !attempted || !errors.Is(err, context.Canceled) || !errors.As(err, &failure) || !failure.CommitAttempted || completion.Outcome != store.TransactionUnknown {
		t.Fatalf("commit outcome: attempted=%t completion=%+v error=%v", attempted, completion, err)
	}
	// The unknown operation is not called a rollback; retrying only the idempotent
	// metadata write converges whether the original committed or not.
	usageWrite(t, ctx, db, event)
	usageAssert(t, usageRead(t, ctx, db, "personal_access_tokens", id), &now)
}
