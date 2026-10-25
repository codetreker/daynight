package store

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/google/uuid"
)

func storeTokenExpiry(value time.Time) *time.Time { return &value }

func TestOptionalTokenExpiryMigrationPreservesHistoryAndSessionContract(t *testing.T) {
	ctx := context.Background()
	pool := emptyPool(t)
	if err := migrate(ctx, pool, schemaMigrations[:17]); err != nil {
		t.Fatal(err)
	}
	s := &Store{Pool: pool}
	_, p, session := testAuthRecords(t, s)
	now := time.Now().UTC().Truncate(time.Microsecond)
	finite := deviceStoreCredential(now)
	finite.ExpiresAt = storeTokenExpiry(now.Add(30 * 24 * time.Hour))
	if err := s.CreatePAT(ctx, p, finite); err != nil {
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
	if err := s.CreatePAT(ctx, p, never); err != nil {
		t.Fatal(err)
	}
	future := now.Add(365 * 24 * time.Hour)
	if _, err := s.Authenticate(ctx, core.PATCredential, never.TokenHash, future); err != nil {
		t.Fatalf("nonexpiring token expired: %v", err)
	}
	if _, err := s.Authenticate(ctx, core.PATCredential, finite.TokenHash, future); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("historical finite expiry lost: %v", err)
	}
	if _, err := s.Authenticate(ctx, core.SessionCredential, session.TokenHash, session.ExpiresAt); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("session became nonexpiring: %v", err)
	}
	if err := s.CreateLogin(ctx, core.LoginTransaction{ID: uuid.NewString(), StateHash: deviceStoreHash("state"), BrowserBindingHash: deviceStoreHash("binding"), Provider: "github", ReturnPath: "/", ExpiresAt: future.Add(time.Minute)}, future); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Authenticate(ctx, core.PATCredential, never.TokenHash, future); err != nil {
		t.Fatalf("cleanup deleted nonexpiring token: %v", err)
	}
}

func TestTokenExpiryUpdatePreservesCredentialAndObservedValue(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	_, alice, _ := testAuthRecords(t, s)
	_, bob, _ := testAuthRecords(t, s)
	now := time.Now().UTC().Truncate(time.Microsecond)
	c := deviceStoreCredential(now)
	if err := s.CreatePAT(ctx, alice, c); err != nil {
		t.Fatal(err)
	}
	first := storeTokenExpiry(now.Add(time.Hour))
	longer := storeTokenExpiry(now.Add(90 * 24 * time.Hour))
	changed, conflict, err := s.UpdatePATExpiry(ctx, alice, c.ID, first, nil, now)
	if err != nil || conflict || changed.ID != c.ID || changed.Name != c.Name || changed.UserID != alice.UserID || changed.TokenHash != nil || !changed.CreatedAt.Equal(c.CreatedAt) || changed.ExpiresAt == nil || !changed.ExpiresAt.Equal(*first) {
		t.Fatalf("expiry update lost metadata: conflict=%t %v", conflict, err)
	}
	if _, conflict, err = s.UpdatePATExpiry(ctx, alice, c.ID, longer, nil, now); err != nil || !conflict {
		t.Fatalf("stale expiry was accepted: %t %v", conflict, err)
	}
	if _, conflict, err = s.UpdatePATExpiry(ctx, alice, c.ID, longer, first, now); err != nil || conflict {
		t.Fatalf("extension failed: %t %v", conflict, err)
	}
	if _, err = s.Authenticate(ctx, core.PATCredential, c.TokenHash, now.Add(31*24*time.Hour)); err != nil {
		t.Fatalf("extension replaced bearer credential: %v", err)
	}
	if _, _, err = s.UpdatePATExpiry(ctx, bob, c.ID, nil, longer, now); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("other user edited token: %v", err)
	}
	if _, conflict, err = s.UpdatePATExpiry(ctx, alice, c.ID, nil, longer, now); err != nil || conflict {
		t.Fatalf("remove expiry: %t %v", conflict, err)
	}
	if _, conflict, err = s.UpdatePATExpiry(ctx, alice, c.ID, nil, nil, now); err != nil || conflict {
		t.Fatalf("matching no-op: %t %v", conflict, err)
	}
	var hash []byte
	if err = s.Pool.QueryRow(ctx, `SELECT token_hash FROM personal_access_tokens WHERE id=$1`, c.ID).Scan(&hash); err != nil || !bytes.Equal(hash, c.TokenHash) {
		t.Fatalf("expiry update replaced credential hash: %v", err)
	}
	pat := alice
	pat.Kind = core.PATCredential
	if _, _, err = s.UpdatePATExpiry(ctx, pat, c.ID, first, nil, now); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("PAT changed expiry: %v", err)
	}
	if _, _, err = s.UpdatePATExpiry(ctx, alice, uuid.NewString(), first, nil, now); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("missing token edited: %v", err)
	}
	if err = s.DeleteCurrentPAT(ctx, core.Principal{UserID: alice.UserID, CredentialID: c.ID}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.UpdatePATExpiry(ctx, alice, c.ID, nil, nil, now); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("revoked token resurrected: %v", err)
	}
	c = deviceStoreCredential(now.Add(-time.Hour))
	c.ExpiresAt = storeTokenExpiry(now.Add(-time.Minute))
	if err = s.CreatePAT(ctx, alice, c); err != nil {
		t.Fatal(err)
	}
	if _, _, err = s.UpdatePATExpiry(ctx, alice, c.ID, nil, c.ExpiresAt, now); !errors.Is(err, core.ErrNotFound) {
		t.Fatalf("expired token resurrected: %v", err)
	}
}

func TestTokenExpiryCompareAndSetSerializesConcurrentEdits(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	_, p, _ := testAuthRecords(t, s)
	now := time.Now().UTC()
	c := deviceStoreCredential(now)
	if err := s.CreatePAT(ctx, p, c); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan bool, 2)
	failures := make(chan error, 2)
	var workers sync.WaitGroup
	for _, duration := range []time.Duration{time.Hour, 2 * time.Hour} {
		workers.Go(func() {
			<-start
			_, conflict, err := s.UpdatePATExpiry(ctx, p, c.ID, storeTokenExpiry(now.Add(duration)), nil, now)
			results <- conflict
			failures <- err
		})
	}
	close(start)
	workers.Wait()
	close(results)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	conflicts := 0
	for conflict := range results {
		if conflict {
			conflicts++
		}
	}
	if conflicts != 1 {
		t.Fatalf("concurrent edit conflicts: %d", conflicts)
	}
}

func TestTokenExpiryPersistenceErrorsRollback(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	_, p, _ := testAuthRecords(t, s)
	now := time.Now().UTC()
	c := deviceStoreCredential(now)
	if err := s.CreatePAT(ctx, p, c); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `ALTER TABLE personal_access_tokens ADD CONSTRAINT only_no_expiry CHECK(expires_at IS NULL)`); err != nil {
		t.Fatal(err)
	}
	_, _, err := s.UpdatePATExpiry(ctx, p, c.ID, storeTokenExpiry(now.Add(time.Hour)), nil, now)
	requireDeviceStoreFailure(t, err)
	listed, err := s.ListPATs(ctx, p, now)
	if err != nil || len(listed) != 1 || listed[0].ExpiresAt != nil {
		t.Fatal("failed expiry update changed credential")
	}
	if _, err = s.Pool.Exec(ctx, `DROP TABLE personal_access_tokens`); err != nil {
		t.Fatal(err)
	}
	_, _, err = s.UpdatePATExpiry(ctx, p, c.ID, nil, nil, now)
	requireDeviceStoreFailure(t, err)
	s.Close()
	_, _, err = s.UpdatePATExpiry(ctx, p, c.ID, nil, nil, now)
	requireDeviceStoreFailure(t, err)
}
