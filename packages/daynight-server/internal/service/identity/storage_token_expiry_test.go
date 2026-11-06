package identity

import (
	"bytes"
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/google/uuid"
)

func TestTokenExpiryUpdatePreservesCredentialAndObservedValue(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	_, alice, _ := testAuthRecords(t, s)
	_, bob, _ := testAuthRecords(t, s)
	now := time.Now().UTC().Truncate(time.Microsecond)
	c := deviceStoreCredential(now)
	if err := testCreatePAT(s, ctx, alice, c); err != nil {
		t.Fatal(err)
	}
	first := storeTokenExpiry(now.Add(time.Hour))
	longer := storeTokenExpiry(now.Add(90 * 24 * time.Hour))
	changed, conflict, err := testUpdatePATExpiry(s, ctx, alice, c.ID, first, nil, now)
	if err != nil || conflict || changed.ID != c.ID || changed.Name != c.Name || changed.UserID != alice.UserID || changed.TokenHash != nil || !changed.CreatedAt.Equal(c.CreatedAt) || changed.ExpiresAt == nil || !changed.ExpiresAt.Equal(*first) {
		t.Fatalf("expiry update lost metadata: conflict=%t %v", conflict, err)
	}
	if _, conflict, err = testUpdatePATExpiry(s, ctx, alice, c.ID, longer, nil, now); err != nil || !conflict {
		t.Fatalf("stale expiry was accepted: %t %v", conflict, err)
	}
	if _, conflict, err = testUpdatePATExpiry(s, ctx, alice, c.ID, longer, first, now); err != nil || conflict {
		t.Fatalf("extension failed: %t %v", conflict, err)
	}
	if _, err = testAuthenticate(s, ctx, model.PATCredential, c.TokenHash, now.Add(31*24*time.Hour)); err != nil {
		t.Fatalf("extension replaced bearer credential: %v", err)
	}
	if _, _, err = testUpdatePATExpiry(s, ctx, bob, c.ID, nil, longer, now); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("other user edited token: %v", err)
	}
	if _, conflict, err = testUpdatePATExpiry(s, ctx, alice, c.ID, nil, longer, now); err != nil || conflict {
		t.Fatalf("remove expiry: %t %v", conflict, err)
	}
	if _, conflict, err = testUpdatePATExpiry(s, ctx, alice, c.ID, nil, nil, now); err != nil || conflict {
		t.Fatalf("matching no-op: %t %v", conflict, err)
	}
	var hash []byte
	if err = s.Pool.QueryRow(ctx, `SELECT token_hash FROM personal_access_tokens WHERE id=$1`, c.ID).Scan(&hash); err != nil || !bytes.Equal(hash, c.TokenHash) {
		t.Fatalf("expiry update replaced credential hash: %v", err)
	}
	pat := alice
	pat.Kind = model.PATCredential
	if _, _, err = testUpdatePATExpiry(s, ctx, pat, c.ID, first, nil, now); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("PAT changed expiry: %v", err)
	}
	if _, _, err = testUpdatePATExpiry(s, ctx, alice, uuid.NewString(), first, nil, now); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("missing token edited: %v", err)
	}
	if err = testDeleteCurrentPAT(s, ctx, model.Principal{UserID: alice.UserID, CredentialID: c.ID}); err != nil {
		t.Fatal(err)
	}
	if _, _, err = testUpdatePATExpiry(s, ctx, alice, c.ID, nil, nil, now); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("revoked token resurrected: %v", err)
	}
	c = deviceStoreCredential(now.Add(-time.Hour))
	c.ExpiresAt = storeTokenExpiry(now.Add(-time.Minute))
	if err = testCreatePAT(s, ctx, alice, c); err != nil {
		t.Fatal(err)
	}
	if _, _, err = testUpdatePATExpiry(s, ctx, alice, c.ID, nil, c.ExpiresAt, now); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("expired token resurrected: %v", err)
	}
}

func TestTokenExpiryCompareAndSetSerializesConcurrentEdits(t *testing.T) {
	s := isolatedStore(t)
	ctx := context.Background()
	_, p, _ := testAuthRecords(t, s)
	now := time.Now().UTC()
	c := deviceStoreCredential(now)
	if err := testCreatePAT(s, ctx, p, c); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan bool, 2)
	failures := make(chan error, 2)
	var workers sync.WaitGroup
	for _, duration := range []time.Duration{time.Hour, 2 * time.Hour} {
		workers.Go(func() {
			<-start
			_, conflict, err := testUpdatePATExpiry(s, ctx, p, c.ID, storeTokenExpiry(now.Add(duration)), nil, now)
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
	if err := testCreatePAT(s, ctx, p, c); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool.Exec(ctx, `ALTER TABLE personal_access_tokens ADD CONSTRAINT only_no_expiry CHECK(expires_at IS NULL)`); err != nil {
		t.Fatal(err)
	}
	_, _, err := testUpdatePATExpiry(s, ctx, p, c.ID, storeTokenExpiry(now.Add(time.Hour)), nil, now)
	requireDeviceStoreFailure(t, err)
	listed, err := testListPATs(s, ctx, p, now)
	if err != nil || len(listed) != 1 || listed[0].ExpiresAt != nil {
		t.Fatal("failed expiry update changed credential")
	}
	if _, err = s.Pool.Exec(ctx, `DROP TABLE personal_access_tokens`); err != nil {
		t.Fatal(err)
	}
	_, _, err = testUpdatePATExpiry(s, ctx, p, c.ID, nil, nil, now)
	requireDeviceStoreFailure(t, err)
	s.Close()
	_, _, err = testUpdatePATExpiry(s, ctx, p, c.ID, nil, nil, now)
	requireDeviceStoreFailure(t, err)
}
