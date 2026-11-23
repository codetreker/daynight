package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPATCreationRollsBackAfterInsertWaitAndSessionExpiry(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	_, p, _ := testAuthRecords(t, s)
	now := time.Now().UTC().Truncate(time.Microsecond)
	old := deviceStoreCredential(now.Add(-2 * time.Hour))
	old.UserID = p.UserID
	expired := now.Add(-time.Hour)
	old.ExpiresAt = &expired
	identityScopeTest(t, s, func(sc store.IdentityScope) error { return sc.IdentityDAO().InsertPAT(ctx, old) })
	if _, err := s.Pool.Exec(ctx, `UPDATE sessions SET expires_at=clock_timestamp()+interval '2 seconds' WHERE id=$1`, p.CredentialID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `CREATE FUNCTION pat_insert_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(7543209001); RETURN NEW; END $$; CREATE TRIGGER pat_insert_gate BEFORE INSERT ON personal_access_tokens FOR EACH ROW EXECUTE FUNCTION pat_insert_gate()`); err != nil {
		t.Fatal(err)
	}
	blocker, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err = blocker.Exec(ctx, `SELECT pg_advisory_xact_lock(7543209001)`); err != nil {
		t.Fatal(err)
	}
	type result struct {
		minted core.MintedPAT
		err    error
	}
	resultCh := make(chan result, 1)
	catalog, err := scopepolicy.NewCatalogSnapshot(scopepolicy.PAT, []scopepolicy.ScopeID{"task:read"})
	if err != nil {
		t.Fatal(err)
	}
	identity := identityservice.NewWithDeviceScopes(s, nil, "", catalog)
	go func() {
		value := "sensitive"
		minted, err := identity.CreateScopedPAT(ctx, p, p.UserID, core.CreatePAT{Name: "blocked create"}, &value, catalog.CatalogRevision, []scopepolicy.ScopeID{"task:read"})
		resultCh <- result{minted, err}
	}()
	waitIdentityLock(t, ctx, s, "%INSERT INTO personal_access_tokens%")
	for {
		var passed bool
		if err := s.Pool.QueryRow(ctx, `SELECT expires_at<=clock_timestamp() FROM sessions WHERE id=$1`, p.CredentialID).Scan(&passed); err != nil {
			t.Fatal(err)
		}
		if passed {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(5 * time.Millisecond):
		}
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	res := <-resultCh
	var fault *model.Fault
	if !errors.As(res.err, &fault) || fault.Code != "unauthenticated" || res.minted.Secret != "" {
		t.Fatalf("creation did not refuse expired session: %v", res.err)
	}
	var count int
	var retained bool
	if err := s.Pool.QueryRow(ctx, `SELECT count(*),bool_or(id=$1) FROM personal_access_tokens`, old.ID).Scan(&count, &retained); err != nil || count != 1 || !retained {
		t.Fatalf("insert or cleanup survived rollback: count=%d retained=%v error=%v", count, retained, err)
	}
}

type poolAcquireTrace struct{ started chan struct{} }

func (t *poolAcquireTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	return ctx
}
func (t *poolAcquireTrace) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}
func (t *poolAcquireTrace) TraceAcquireStart(ctx context.Context, _ *pgxpool.Pool, _ pgxpool.TraceAcquireStartData) context.Context {
	if ctx.Value(poolWaitKey{}) != nil {
		close(t.started)
	}
	return ctx
}
func (t *poolAcquireTrace) TraceAcquireEnd(context.Context, *pgxpool.Pool, pgxpool.TraceAcquireEndData) {
}

type poolWaitKey struct{}

func TestPATManagementCancelsPoolWaitAndReleasesCapacity(t *testing.T) {
	s := isolatedStore(t)
	ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
	defer cancel()
	_, p, _ := testAuthRecords(t, s)
	config := s.Pool.Config().Copy()
	config.MaxConns = 1
	config.MinConns = 0
	trace := &poolAcquireTrace{started: make(chan struct{})}
	config.ConnConfig.Tracer = trace
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	occupied, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Release()
	waiting, cancelWait := context.WithCancel(context.WithValue(ctx, poolWaitKey{}, true))
	result := make(chan error, 1)
	go func() {
		_, err := identityservice.New(&Store{Pool: pool}, nil, "").ListPATsV2(waiting, p)
		result <- err
	}()
	select {
	case <-trace.started:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if pool.Stat().AcquiredConns() != 1 {
		t.Fatal("pool slot was not occupied")
	}
	select {
	case err := <-result:
		t.Fatalf("operation did not wait for pool: %v", err)
	default:
	}
	cancelWait()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("pool cancellation: %v", err)
	}
	occupied.Release()
	items, err := identityservice.New(&Store{Pool: pool}, nil, "").ListPATsV2(ctx, p)
	if err != nil || len(items) != 0 {
		t.Fatalf("subsequent read: %v", err)
	}
}

func TestPATDescriptionInterleavesWithExpiryUsageRevocationAndCleanup(t *testing.T) {
	for _, operation := range []string{"expiry", "usage", "revocation", "cleanup"} {
		t.Run(operation, func(t *testing.T) {
			s := isolatedStore(t)
			ctx, cancel := context.WithTimeout(t.Context(), 20*time.Second)
			defer cancel()
			_, p, _ := testAuthRecords(t, s)
			now := time.Now().UTC().Truncate(time.Microsecond)
			pat := deviceStoreCredential(now)
			pat.UserID = p.UserID
			if operation == "cleanup" {
				pat.CreatedAt = now.Add(-2 * time.Hour)
				expired := now.Add(-time.Hour)
				pat.ExpiresAt = &expired
			}
			identityScopeTest(t, s, func(sc store.IdentityScope) error { return sc.IdentityDAO().InsertPAT(ctx, pat) })
			value := "description"
			if operation == "expiry" {
				blocker, err := s.Pool.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer blocker.Rollback(context.Background())
				expiry := now.Add(time.Hour)
				if _, err = blocker.Exec(ctx, `UPDATE personal_access_tokens SET expires_at=$2 WHERE id=$1`, pat.ID, expiry); err != nil {
					t.Fatal(err)
				}
				result := make(chan error, 1)
				go func() {
					_, _, err := identityservice.New(s, nil, "").UpdatePATDescription(ctx, p, pat.ID, p.UserID, nil, &value)
					result <- err
				}()
				waitIdentityLock(t, ctx, s, "%UPDATE personal_access_tokens SET description%")
				if err = blocker.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				if err = <-result; err != nil {
					t.Fatal(err)
				}
				var got time.Time
				var description *string
				var hash []byte
				if err = s.Pool.QueryRow(ctx, `SELECT expires_at,description,token_hash FROM personal_access_tokens WHERE id=$1`, pat.ID).Scan(&got, &description, &hash); err != nil || !got.Equal(expiry) || description == nil || *description != value || string(hash) != string(pat.TokenHash) {
					t.Fatalf("expiry/description fields: %v", err)
				}
				return
			}
			locked, release := make(chan struct{}), make(chan struct{})
			edited := make(chan error, 1)
			go func() {
				_, err := s.WriteIdentity(ctx, func(sc store.IdentityScope) error {
					d := sc.IdentityDAO()
					_, _, err := core.NewIdentity("").UpdatePATDescription(ctx, d, d.(store.PATManagementDAO), p, pat.ID, p.UserID, nil, &value, now)
					if err != nil {
						return err
					}
					close(locked)
					select {
					case <-release:
						return nil
					case <-ctx.Done():
						return ctx.Err()
					}
				})
				edited <- err
			}()
			select {
			case <-locked:
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			switch operation {
			case "usage":
				event := model.CredentialUsageEvent{Kind: model.UsageSubjectPAT, UserID: p.UserID, SubjectID: pat.ID, At: now}
				completion, err := s.WriteCredentialUsage(ctx, []model.CredentialUsageEvent{event})
				if err == nil || completion.Outcome != store.TransactionNotCommitted {
					t.Fatalf("usage must fail without waiting while row locked: %v %v", completion, err)
				}
				close(release)
				if err = <-edited; err != nil {
					t.Fatal(err)
				}
				completion, err = s.WriteCredentialUsage(ctx, []model.CredentialUsageEvent{event})
				if err != nil || completion.Outcome != store.TransactionCommitted {
					t.Fatalf("usage after edit: %v %v", completion, err)
				}
				var description *string
				var used time.Time
				if err = s.Pool.QueryRow(ctx, `SELECT description,last_used_at FROM personal_access_tokens WHERE id=$1`, pat.ID).Scan(&description, &used); err != nil || description == nil || *description != value || !used.Equal(now) {
					t.Fatalf("usage/description fields: %v", err)
				}
			case "revocation":
				revoked := make(chan error, 1)
				go func() {
					_, err := s.WriteIdentity(ctx, func(sc store.IdentityScope) error {
						return core.NewIdentity("").RevokePAT(ctx, sc.IdentityDAO(), p, pat.ID, now)
					})
					revoked <- err
				}()
				waitIdentityLock(t, ctx, s, "%DELETE FROM personal_access_tokens WHERE id=%")
				close(release)
				if err := <-edited; err != nil {
					t.Fatal(err)
				}
				if err := <-revoked; err != nil {
					t.Fatal(err)
				}
				var exists bool
				if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM personal_access_tokens WHERE id=$1)`, pat.ID).Scan(&exists); err != nil || exists {
					t.Fatalf("revocation failed: %v", err)
				}
			case "cleanup":
				identityScopeTest(t, s, func(sc store.IdentityScope) error { return sc.IdentityDAO().CleanupCredentials(ctx, now) })
				var exists bool
				if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM personal_access_tokens WHERE id=$1)`, pat.ID).Scan(&exists); err != nil || !exists {
					t.Fatalf("cleanup did not skip locked PAT: %v", err)
				}
				close(release)
				if err := <-edited; err != nil {
					t.Fatal(err)
				}
				identityScopeTest(t, s, func(sc store.IdentityScope) error { return sc.IdentityDAO().CleanupCredentials(ctx, now) })
				if err := s.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM personal_access_tokens WHERE id=$1)`, pat.ID).Scan(&exists); err != nil || exists {
					t.Fatalf("cleanup did not remove released PAT: %v", err)
				}
			}
		})
	}
}
