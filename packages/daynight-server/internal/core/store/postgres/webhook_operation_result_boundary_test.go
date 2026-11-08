package postgres

import (
	"bytes"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestWebhookRotationReceiptRetainsResultAfterKeyAndEndpointRemoval(t *testing.T) {
	for _, mode := range []string{"immediate", "overlap"} {
		t.Run(mode, func(t *testing.T) {
			s := isolatedStore(t)
			ctx := t.Context()
			owner, endpoint, key, receipt := webhookStoredFixture(t)
			endpoint.ConfigVersion = 2
			receipt.Kind, receipt.ConfigVersion = "signing.rotate", 2
			receipt.ActiveKeyID, receipt.SigningMode = key.ID, mode
			if mode == "overlap" {
				deadline := receipt.RecordedAt.Add(time.Hour)
				receipt.OverlapUntil = &deadline
			}
			completion, err := s.WriteWebhook(ctx, owner, receipt.ID, func(sc store.WebhookWriteScope) error {
				dao := sc.WebhookWriter()
				if err := dao.PutEndpoint(ctx, endpoint); err != nil {
					return err
				}
				if err := dao.PutSigningKey(ctx, key); err != nil {
					return err
				}
				return dao.PutOperation(ctx, receipt)
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("rotation storage: %v %v", completion, err)
			}
			assertOriginalReceipt := func(stage string) {
				t.Helper()
				if err := s.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
					got, err := sc.WebhookDAO().Operation(ctx, owner, receipt.ID)
					if err != nil {
						return err
					}
					if got.Kind != "signing.rotate" || got.TargetID != endpoint.ID || got.ConfigVersion != 2 || got.ActiveKeyID != key.ID || got.SigningMode != mode || got.RequestSHA256 != receipt.RequestSHA256 || got.Fingerprint != receipt.Fingerprint {
						t.Fatalf("%s changed original receipt result: %+v", stage, got)
					}
					if mode == "immediate" {
						if got.OverlapUntil != nil {
							t.Fatalf("%s added immediate rotation overlap deadline: %v", stage, got.OverlapUntil)
						}
					} else if got.OverlapUntil == nil || !got.OverlapUntil.Equal(*receipt.OverlapUntil) {
						t.Fatalf("%s changed original overlap deadline: got=%v want=%v", stage, got.OverlapUntil, receipt.OverlapUntil)
					}
					return nil
				}); err != nil {
					t.Fatal(err)
				}
			}
			assertOriginalReceipt("stored")
			replacement := key
			replacement.ID, replacement.Secret = uuid.NewString(), bytes.Repeat([]byte{3}, 32)
			endpoint.ActiveKeyID, endpoint.ConfigVersion = replacement.ID, 3
			completion, err = s.WriteWebhook(ctx, owner, uuid.NewString(), func(sc store.WebhookWriteScope) error {
				dao := sc.WebhookWriter()
				if err := dao.DeleteSigningKeys(ctx, endpoint.ID); err != nil {
					return err
				}
				if err := dao.PutSigningKey(ctx, replacement); err != nil {
					return err
				}
				return dao.PutEndpoint(ctx, endpoint)
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("key replacement storage: %v %v", completion, err)
			}
			if err = s.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
				current, err := sc.WebhookDAO().Endpoint(ctx, owner, endpoint.ID)
				if err != nil {
					return err
				}
				keys, err := sc.WebhookDAO().SigningKeys(ctx, endpoint.ID)
				if err != nil {
					return err
				}
				if current.ActiveKeyID != replacement.ID || len(keys) != 1 || keys[0].ID != replacement.ID {
					t.Fatalf("replacement did not remove original key: endpoint=%+v keys=%+v", current, keys)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			assertOriginalReceipt("key replacement")
			deleted := time.Now().UTC().Truncate(time.Microsecond)
			endpoint.DeletedAt, endpoint.ConfigVersion = &deleted, 4
			completion, err = s.WriteWebhook(ctx, owner, uuid.NewString(), func(sc store.WebhookWriteScope) error {
				dao := sc.WebhookWriter()
				if err := dao.PutEndpoint(ctx, endpoint); err != nil {
					return err
				}
				return dao.DeleteSigningKeys(ctx, endpoint.ID)
			})
			if err != nil || completion.Outcome != store.TransactionCommitted {
				t.Fatalf("endpoint tombstone storage: %v %v", completion, err)
			}
			if err = s.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
				current, err := sc.WebhookDAO().Endpoint(ctx, owner, endpoint.ID)
				if err != nil {
					return err
				}
				keys, err := sc.WebhookDAO().SigningKeys(ctx, endpoint.ID)
				if err != nil {
					return err
				}
				if current.DeletedAt == nil || current.ActiveKeyID != "" || len(keys) != 0 {
					t.Fatalf("target was not tombstoned/key-free: endpoint=%+v keys=%+v", current, keys)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			assertOriginalReceipt("endpoint deletion")
		})
	}
}
