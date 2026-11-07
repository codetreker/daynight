package webhook

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type inventoryFailureReader struct {
	source store.WebhookRecoveryReader
	mode   string
	cause  error
}
type inventoryFailureSnapshot struct {
	store.WebhookRecoverySnapshot
	mode  string
	cause error
}

func (r inventoryFailureReader) OpenWebhookRecoverySnapshot(ctx context.Context) (store.WebhookRecoverySnapshot, error) {
	if r.mode == "open" {
		return nil, r.cause
	}
	snapshot, err := r.source.OpenWebhookRecoverySnapshot(ctx)
	if err != nil {
		return nil, err
	}
	return inventoryFailureSnapshot{WebhookRecoverySnapshot: snapshot, mode: r.mode, cause: r.cause}, nil
}
func (s inventoryFailureSnapshot) RecoveryIdentity(ctx context.Context) (store.WebhookRecoveryIdentity, error) {
	if s.mode == "identity-error" {
		return store.WebhookRecoveryIdentity{}, s.cause
	}
	if s.mode == "identity-invalid" {
		return store.WebhookRecoveryIdentity{}, nil
	}
	return s.WebhookRecoverySnapshot.RecoveryIdentity(ctx)
}
func (s inventoryFailureSnapshot) WebhookMasterKeyIDs(ctx context.Context) ([]string, error) {
	if s.mode == "references" {
		return nil, s.cause
	}
	return s.WebhookRecoverySnapshot.WebhookMasterKeyIDs(ctx)
}
func (s inventoryFailureSnapshot) Close(ctx context.Context) error {
	err := s.WebhookRecoverySnapshot.Close(ctx)
	if s.mode == "close" {
		return errors.Join(err, s.cause)
	}
	return err
}

func TestRecoveryDatabaseInventoryFailuresAndCleanup(t *testing.T) {
	f := newFixture(t, false)
	ctx := context.Background()
	id, ids, err := recoveryDatabaseInventory(ctx, f.db)
	if err != nil || id.ClusterID == "" || id.DatabaseOID == 0 || len(ids) != 0 {
		t.Fatalf("actual inventory %+v %v %v", id, ids, err)
	}
	cause := errors.New("controlled inventory failure")
	for _, mode := range []string{"open", "identity-error", "identity-invalid", "references", "close"} {
		t.Run(mode, func(t *testing.T) {
			reader := inventoryFailureReader{source: f.db, mode: mode, cause: cause}
			_, _, err := recoveryDatabaseInventory(ctx, reader)
			if err == nil || mode != "identity-invalid" && !errors.Is(err, cause) {
				t.Fatalf("%s error: %v", mode, err)
			}
			if err = f.db.Pool.Ping(ctx); err != nil {
				t.Fatalf("database after %s: %v", mode, err)
			}
		})
	}
	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, _, err = recoveryDatabaseInventory(cancelled, f.db)
	if err == nil {
		t.Fatal("cancelled inventory accepted")
	}
	if _, err = f.db.Pool.Exec(ctx, `ALTER TABLE webhook_signing_keys RENAME TO inaccessible_webhook_signing_keys`); err != nil {
		t.Fatal(err)
	}
	_, _, err = recoveryDatabaseInventory(ctx, f.db)
	if err == nil {
		t.Fatal("missing ciphertext source accepted")
	}
	if !strings.Contains(err.Error(), "inventory online webhook references") {
		t.Fatalf("missing reference context: %v", err)
	}
}
