package webhook_test

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
)

func TestWebhookPersistenceAndSnapshot(t *testing.T) {
	s := testutil.OpenStore(t, postgres.Open)
	ctx := context.Background()
	owner, endpoint, key, receipt := managementRecords(t)
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
		t.Fatalf("write %v %v", completion, err)
	}
	err = s.ReadWebhookSnapshot(ctx, func(sc store.WebhookReadScope) error {
		dao := sc.WebhookDAO()
		got, err := dao.Endpoint(ctx, owner, endpoint.ID)
		if err != nil {
			return err
		}
		if got.Name != endpoint.Name || !bytes.Equal(got.DestinationConfiguration, endpoint.DestinationConfiguration) {
			t.Fatalf("endpoint %#v", got)
		}
		keys, err := dao.SigningKeys(ctx, endpoint.ID)
		if err != nil {
			return err
		}
		if len(keys) != 1 || keys[0].ID != key.ID || !bytes.Equal(keys[0].Secret, key.Secret) {
			t.Fatalf("keys %#v", keys)
		}
		saved, err := dao.Operation(ctx, owner, receipt.ID)
		if err != nil {
			return err
		}
		if saved.RequestSHA256 != receipt.RequestSHA256 || saved.Fingerprint != receipt.Fingerprint || saved.IssuedAt != receipt.IssuedAt {
			t.Fatalf("receipt %#v", saved)
		}
		endpoints, err := dao.Endpoints(ctx, owner)
		if err != nil {
			return err
		}
		if len(endpoints) != 1 {
			t.Fatalf("endpoints %#v", endpoints)
		}
		policy, err := dao.Policy(ctx, 1)
		if err != nil {
			return err
		}
		if policy.OperationMaxAgeSeconds != 300 || policy.KeyOverlapMaxSeconds != 604800 {
			t.Fatalf("policy %#v", policy)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestWebhookRotationReceiptRetainsResultAfterKeyAndEndpointRemoval(t *testing.T) {
	for _, mode := range []string{"immediate", "overlap"} {
		t.Run(mode, func(t *testing.T) {
			s := testutil.OpenStore(t, postgres.Open)
			ctx := t.Context()
			owner, endpoint, key, receipt := managementRecords(t)
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
			endpoint.Enabled, endpoint.UpdatedAt = false, deleted
			endpoint.Name, endpoint.DestinationKind, endpoint.AdapterVersion, endpoint.Origin, endpoint.ActiveKeyID = "", "", "", "", ""
			endpoint.DestinationConfiguration = nil
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
				if current.DeletedAt == nil || current.Enabled || current.ActiveKeyID != "" || len(keys) != 0 {
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

func TestWebhookDatabaseFailures(t *testing.T) {
	for _, kind := range []string{"missing endpoint", "endpoint read", "key read", "key insert", "key delete", "missing policy"} {
		t.Run(kind, func(t *testing.T) {
			s := testutil.OpenStore(t, postgres.Open)
			ctx := context.Background()
			owner, endpoint, key, _ := managementRecords(t)
			var operation func(store.WebhookWriteScope) error
			switch kind {
			case "missing endpoint":
				operation = func(sc store.WebhookWriteScope) error {
					_, err := sc.WebhookWriter().LockEndpoint(ctx, owner, endpoint.ID)
					return err
				}
			case "endpoint read":
				testutil.MustExec(t, s.Pool, `DROP TABLE webhook_endpoints`)
				operation = func(sc store.WebhookWriteScope) error { _, err := sc.WebhookWriter().Endpoints(ctx, owner); return err }
			case "key read", "key delete":
				testutil.MustExec(t, s.Pool, `DROP TABLE webhook_signing_keys`)
				if kind == "key read" {
					operation = func(sc store.WebhookWriteScope) error {
						_, err := sc.WebhookWriter().SigningKeys(ctx, endpoint.ID)
						return err
					}
				} else {
					operation = func(sc store.WebhookWriteScope) error { return sc.WebhookWriter().DeleteSigningKeys(ctx, endpoint.ID) }
				}
			case "key insert":
				testutil.MustExec(t, s.Pool, `CREATE FUNCTION reject_key() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='P1902', MESSAGE='key storage failure'; END $$; CREATE TRIGGER reject_key BEFORE INSERT ON webhook_signing_keys FOR EACH ROW EXECUTE FUNCTION reject_key()`)
				operation = func(sc store.WebhookWriteScope) error { return sc.WebhookWriter().PutSigningKey(ctx, key) }
			case "missing policy":
				testutil.MustExec(t, s.Pool, `DELETE FROM webhook_policies WHERE version=1`)
				operation = func(sc store.WebhookWriteScope) error { _, err := sc.WebhookWriter().Policy(ctx, 1); return err }
			}
			completion, err := s.WriteWebhook(ctx, owner, uuid.NewString(), operation)
			if completion.Outcome != store.TransactionNotCommitted || err == nil {
				t.Fatalf("unexpected result %v %v", completion, err)
			}
			if kind == "missing endpoint" || kind == "missing policy" {
				if !errors.Is(err, model.ErrNotFound) {
					t.Fatalf("missing record cause: %v", err)
				}
				return
			}
			failed, code := store.DatabaseErrorFacts(err)
			if !failed || (kind == "key insert" && code != "P1902") {
				t.Fatalf("database failure cause lost: %v %q %v", failed, code, err)
			}
		})
	}
}

func managementRecords(t *testing.T) (webhook.Owner, webhook.Endpoint, webhook.SigningKey, webhook.Operation) {
	t.Helper()
	owner := webhook.Owner{Kind: "personal", ID: uuid.NewString()}
	id, keyID := uuid.NewString(), uuid.NewString()
	now := time.Now().UTC().Truncate(time.Microsecond)
	configuration := []byte(`{"kind":"http","adapterVersion":"1","configuration":{"url":"https://example.org/hook"}}`)
	endpoint := webhook.Endpoint{ID: id, Owner: owner, Name: "sample", Enabled: true, ConfigVersion: 1, DestinationRevision: 1, DestinationKind: "http", AdapterVersion: "1", Origin: "https://example.org", DestinationConfiguration: configuration, ActiveKeyID: keyID, CreatedAt: now, UpdatedAt: now}
	key := webhook.SigningKey{EndpointID: id, ID: keyID, Slot: "current", Secret: bytes.Repeat([]byte{2}, 32), CreatedAt: now}
	receipt := webhook.Operation{Owner: owner, ID: uuid.NewString(), ActorID: owner.ID, Kind: "endpoint.create", TargetID: id, IssuedAt: now.Format(time.RFC3339Nano), RequestSHA256: strings.Repeat("a", 64), Fingerprint: strings.Repeat("b", 64), Effect: "applied", ConfigVersion: 1, DestinationRevisionAfter: 1, RecordedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)}
	return owner, endpoint, key, receipt
}
