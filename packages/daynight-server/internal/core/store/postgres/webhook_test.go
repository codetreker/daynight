package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	whcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook"
	wh "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func storedWebhook(t *testing.T, actor model.Principal, project model.Project) wh.Endpoint {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Microsecond)
	key := uuid.NewString()
	return wh.Endpoint{ID: uuid.NewString(), Owner: wh.Owner{Kind: wh.PersonalOwner, ID: actor.UserID}, Name: "Notifications", Enabled: true, ConfigVersion: 1, DestinationRevision: 1,
		DestinationKind: "http", AdapterVersion: 1, DestinationOrigin: "https://receiver.example", EncryptedDestination: []byte("opaque destination ciphertext"), ActiveKeyID: key,
		SigningKeys:   []wh.SigningKey{{ID: key, EncryptedSecret: []byte("opaque signing ciphertext"), CreatedAt: now}},
		Subscriptions: []wh.Subscription{{ID: uuid.NewString(), ProjectID: project.ID, AuthorizationState: wh.AuthorizationActive, AuthorizationEpoch: 1, Bindings: []wh.Binding{{ID: uuid.NewString(), EventType: "task.paused"}}}},
		CreatedAt:     now, UpdatedAt: now}
}

func webhookReceipt(endpoint wh.Endpoint, operationID string) wh.OperationReceipt {
	digest := sha256.Sum256([]byte(operationID))
	now := time.Now().UTC().Truncate(time.Microsecond)
	return wh.OperationReceipt{OperationID: operationID, Kind: wh.EndpointCreate, IssuedAt: now.Format(time.RFC3339Nano), RequestSHA256: hex.EncodeToString(digest[:]), Fingerprint: hex.EncodeToString(digest[:]),
		ActorUserID: endpoint.Owner.ID, Owner: endpoint.Owner, EndpointID: endpoint.ID, Effect: wh.EffectApplied, ConfigVersionAfter: endpoint.ConfigVersion,
		DestinationRevisionAfter: endpoint.DestinationRevision, RecordedAt: now, ExpiresAt: now.Add(30 * 24 * time.Hour)}
}

func insertStoredWebhook(ctx context.Context, scope store.WebhookWriteScope, endpoint wh.Endpoint, receipt wh.OperationReceipt) error {
	dao := scope.WebhookDAO()
	ids := whcore.ProjectIDs(endpoint)
	if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: endpoint.Owner, ActorUserID: endpoint.Owner.ID, ProjectIDs: ids, RequiredProjectIDs: ids, Expansion: true}); err != nil {
		return err
	}
	if err := dao.ReserveOperation(ctx, endpoint.Owner, receipt.RecordedAt); err != nil {
		return err
	}
	cost, err := whcore.ConfigurationCost(endpoint)
	if err != nil {
		return err
	}
	if err := dao.ReserveConfiguration(ctx, endpoint.Owner, cost); err != nil {
		return err
	}
	if err := dao.InsertEndpoint(ctx, endpoint); err != nil {
		return err
	}
	return dao.InsertOperation(ctx, receipt)
}

func saveStoredWebhook(ctx context.Context, scope store.WebhookWriteScope, before, after wh.Endpoint, receipt wh.OperationReceipt, expected int64, expansion bool) error {
	dao := scope.WebhookDAO()
	ids := whcore.ProjectIDs(after)
	if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: after.Owner, ActorUserID: after.Owner.ID, EndpointID: after.ID, ProjectIDs: ids, RequiredProjectIDs: ids, Expansion: expansion}); err != nil {
		return err
	}
	if err := dao.ReserveOperation(ctx, after.Owner, receipt.RecordedAt); err != nil {
		return err
	}
	afterCost, err := whcore.ConfigurationCost(after)
	if err != nil {
		return err
	}
	beforeCost, err := whcore.ConfigurationCost(before)
	if err != nil {
		return err
	}
	if err := dao.ReserveConfiguration(ctx, after.Owner, whcore.CostDifference(afterCost, beforeCost)); err != nil {
		return err
	}
	if err := dao.SaveEndpoint(ctx, after, expected); err != nil {
		return err
	}
	return dao.InsertOperation(ctx, receipt)
}

func readStoredWebhook(t *testing.T, s *Store, owner wh.Owner, id string) wh.Endpoint {
	t.Helper()
	var result wh.Endpoint
	err := s.ReadSnapshot(context.Background(), func(scope store.SnapshotScope) error {
		var err error
		result, err = scope.WebhookDAO().Endpoint(context.Background(), owner, id)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestWebhookConfigurationAndReceiptCommitAtomically(t *testing.T) {
	s, actor, other, project := membershipFixture(t)
	ctx := context.Background()
	endpoint := storedWebhook(t, actor, project)
	receipt := webhookReceipt(endpoint, uuid.NewString())
	completion, err := s.WriteWebhook(ctx, endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error { return insertStoredWebhook(ctx, scope, endpoint, receipt) })
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatalf("create: %v %#v", err, completion)
	}
	if got := readStoredWebhook(t, s, endpoint.Owner, endpoint.ID); !reflect.DeepEqual(got, endpoint) {
		t.Fatalf("configuration changed across persistence: %#v", got)
	}
	if err := s.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		dao := scope.WebhookDAO()
		got, err := dao.Operation(ctx, endpoint.Owner, receipt.OperationID)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(got, receipt) {
			t.Fatalf("receipt changed: %#v", got)
		}
		access, err := dao.OwnerAccess(ctx, endpoint.Owner, other.UserID)
		if err != nil {
			return err
		}
		if access.CanRead || access.CanManage {
			t.Fatalf("other personal owner gained access: %#v", access)
		}
		page, err := dao.Endpoints(ctx, endpoint.Owner, actor.UserID, store.WebhookEndpointQuery{Search: "receiver", Page: store.Page{Limit: 1}})
		if err != nil {
			return err
		}
		if len(page.Items) != 1 || page.HasMore || page.Items[0].ID != endpoint.ID {
			t.Fatalf("visible-origin search: %#v", page)
		}
		page, err = dao.Endpoints(ctx, endpoint.Owner, actor.UserID, store.WebhookEndpointQuery{Search: "opaque", Page: store.Page{Limit: 1}})
		if err == nil && len(page.Items) != 0 {
			t.Fatal("search matched ciphertext or private configuration")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	failed := storedWebhook(t, actor, project)
	failedReceipt := webhookReceipt(failed, uuid.NewString())
	cause := errors.New("failure after receipt and endpoint writes")
	completion, err = s.WriteWebhook(ctx, failed.Owner, failedReceipt.OperationID, func(scope store.WebhookWriteScope) error {
		if err := insertStoredWebhook(ctx, scope, failed, failedReceipt); err != nil {
			return err
		}
		return cause
	})
	if !errors.Is(err, cause) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("rollback: %v %#v", err, completion)
	}
	if err := s.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		_, endpointErr := scope.WebhookDAO().Endpoint(ctx, failed.Owner, failed.ID)
		_, operationErr := scope.WebhookDAO().Operation(ctx, failed.Owner, failedReceipt.OperationID)
		if !errors.Is(endpointErr, model.ErrNotFound) || !errors.Is(operationErr, model.ErrNotFound) {
			t.Fatalf("partial mutation survived rollback: %v %v", endpointErr, operationErr)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestWebhookCommitResponseLossRetainsRecoverableOriginalReceipt(t *testing.T) {
	s, actor, _, project := membershipFixture(t)
	ctx := context.Background()
	endpoint := storedWebhook(t, actor, project)
	receipt := webhookReceipt(endpoint, uuid.NewString())
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		t.Fatal(err)
	}
	lost := errors.New("Webhook commit response lost")
	err = writeWebhookTx(ctx, &threadCommitResponseLoss{Tx: tx, cause: lost}, endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error { return insertStoredWebhook(ctx, scope, endpoint, receipt) })
	completion, err := teamCompletion("Webhook write", err)
	if !errors.Is(err, lost) || completion.Outcome != store.TransactionUnknown {
		t.Fatalf("unknown commit mislabeled: %#v %v", completion, err)
	}
	if got := readStoredWebhook(t, s, endpoint.Owner, endpoint.ID); got.ConfigVersion != 1 {
		t.Fatalf("actual committed configuration missing: %#v", got)
	}
	if err := s.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		got, err := scope.WebhookDAO().Operation(ctx, endpoint.Owner, receipt.OperationID)
		if err == nil && (got.IssuedAt != receipt.IssuedAt || got.RequestSHA256 != receipt.RequestSHA256 || got.Fingerprint != receipt.Fingerprint) {
			t.Fatalf("original intent binding lost: %#v", got)
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestWebhookCASBindingHistoryAndDeletedSecretRetirement(t *testing.T) {
	s, actor, _, project := membershipFixture(t)
	ctx := context.Background()
	endpoint := storedWebhook(t, actor, project)
	receipt := webhookReceipt(endpoint, uuid.NewString())
	if _, err := s.WriteWebhook(ctx, endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error { return insertStoredWebhook(ctx, scope, endpoint, receipt) }); err != nil {
		t.Fatal(err)
	}
	updated := readStoredWebhook(t, s, endpoint.Owner, endpoint.ID)
	now := updated.UpdatedAt.Add(time.Second)
	updated.ConfigVersion, updated.UpdatedAt = 2, now
	oldBinding := updated.Subscriptions[0].Bindings[0].ID
	updated.Subscriptions[0].Bindings[0].DeletedAt = &now
	newBinding := uuid.NewString()
	updated.Subscriptions[0].Bindings = append(updated.Subscriptions[0].Bindings, wh.Binding{ID: newBinding, EventType: "task.paused"})
	replace := webhookReceipt(updated, uuid.NewString())
	replace.Kind = wh.EndpointPatch
	if _, err := s.WriteWebhook(ctx, updated.Owner, replace.OperationID, func(scope store.WebhookWriteScope) error {
		return saveStoredWebhook(ctx, scope, endpoint, updated, replace, 1, true)
	}); err != nil {
		t.Fatal(err)
	}
	got := readStoredWebhook(t, s, endpoint.Owner, endpoint.ID)
	if got.Subscriptions[0].Bindings[0].ID == got.Subscriptions[0].Bindings[1].ID || got.Subscriptions[0].AuthorizationEpoch != 1 {
		t.Fatalf("binding identity or continuous epoch changed: %#v", got)
	}
	for _, binding := range got.Subscriptions[0].Bindings {
		if binding.ID == oldBinding && binding.DeletedAt == nil || binding.ID == newBinding && binding.DeletedAt != nil {
			t.Fatalf("removed/readded identity revived: %#v", binding)
		}
	}
	stale := webhookReceipt(updated, uuid.NewString())
	_, err := s.WriteWebhook(ctx, updated.Owner, stale.OperationID, func(scope store.WebhookWriteScope) error {
		return saveStoredWebhook(ctx, scope, endpoint, updated, stale, 1, true)
	})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_conflict" {
		t.Fatalf("stale same-value update was accepted: %v", err)
	}
	deleted := readStoredWebhook(t, s, endpoint.Owner, endpoint.ID)
	deleted.ConfigVersion++
	deleted.UpdatedAt = now.Add(time.Second)
	deleted.DeletedAt = &deleted.UpdatedAt
	deleted.Name, deleted.DestinationOrigin, deleted.ActiveKeyID = "", "", ""
	deleted.EncryptedDestination = nil
	deleted.SigningKeys = []wh.SigningKey{}
	for i := range deleted.Subscriptions {
		deleted.Subscriptions[i].DeletedAt = deleted.DeletedAt
		for j := range deleted.Subscriptions[i].Bindings {
			deleted.Subscriptions[i].Bindings[j].DeletedAt = deleted.DeletedAt
		}
	}
	remove := webhookReceipt(deleted, uuid.NewString())
	remove.Kind = wh.EndpointDelete
	if _, err := s.WriteWebhook(ctx, deleted.Owner, remove.OperationID, func(scope store.WebhookWriteScope) error {
		return saveStoredWebhook(ctx, scope, got, deleted, remove, 2, false)
	}); err != nil {
		t.Fatal(err)
	}
	tombstone := readStoredWebhook(t, s, endpoint.Owner, endpoint.ID)
	if tombstone.DeletedAt == nil || tombstone.Name != "" || len(tombstone.EncryptedDestination) != 0 || len(tombstone.SigningKeys) != 0 {
		t.Fatalf("deleted secret configuration retained: %#v", tombstone)
	}
	if err := s.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
		page, err := scope.WebhookDAO().Endpoints(ctx, deleted.Owner, actor.UserID, store.WebhookEndpointQuery{Page: store.Page{Limit: 10}})
		if err == nil && len(page.Items) != 0 {
			t.Fatal("tombstone leaked into active list")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestWebhookOperationFenceSerializesOriginalEffect(t *testing.T) {
	s, actor, _, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	endpoint := storedWebhook(t, actor, project)
	receipt := webhookReceipt(endpoint, uuid.NewString())
	pid := make(chan uint32, 1)
	release := make(chan struct{})
	first := make(chan error, 1)
	go func() {
		_, err := s.WriteWebhook(ctx, endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error {
			pid <- scope.(*webhookScope).tx.Conn().PgConn().PID()
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			return insertStoredWebhook(ctx, scope, endpoint, receipt)
		})
		first <- err
	}()
	blocker := <-pid
	second := make(chan error, 1)
	go func() {
		_, err := s.WriteWebhook(ctx, endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error {
			actual, err := scope.WebhookDAO().Operation(ctx, endpoint.Owner, receipt.OperationID)
			if err == nil && actual.EndpointID != endpoint.ID {
				return errors.New("operation fence lost its original endpoint")
			}
			return err
		})
		second <- err
	}()
	waitTransferTeamLock(t, ctx, s, "SELECT pg_advisory_xact_lock", blocker)
	close(release)
	if err := <-first; err != nil {
		t.Fatal(err)
	}
	if err := <-second; err != nil {
		t.Fatal(err)
	}
	var endpoints, operations int
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations)`).Scan(&endpoints, &operations); err != nil {
		t.Fatal(err)
	}
	if endpoints != 1 || operations != 1 {
		t.Fatalf("original effect duplicated: endpoints=%d operations=%d", endpoints, operations)
	}
}

func TestWebhookCapacityRejectsBeforeEffectAndReleasesExpiredReceipts(t *testing.T) {
	for _, test := range []struct{ name, mutation, code string }{
		{"owner operation slots", `UPDATE webhook_quota_owners SET operations_used=1024`, "operation_capacity"},
		{"bucket operation slots", `UPDATE webhook_quota_buckets SET operations_used=8192 WHERE bucket=(SELECT bucket FROM webhook_quota_owners LIMIT 1)`, "operation_capacity"},
		{"owner configuration slots", `UPDATE webhook_quota_owners SET records_used=32768`, "webhook_capacity_unavailable"},
		{"bucket configuration bytes", `UPDATE webhook_quota_buckets SET bytes_used=268435456 WHERE bucket=(SELECT bucket FROM webhook_quota_owners LIMIT 1)`, "webhook_capacity_unavailable"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, actor, _, project := membershipFixture(t)
			ctx := context.Background()
			endpoint := storedWebhook(t, actor, project)
			receipt := webhookReceipt(endpoint, uuid.NewString())
			if _, err := s.WriteWebhook(ctx, endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error { return insertStoredWebhook(ctx, scope, endpoint, receipt) }); err != nil {
				t.Fatal(err)
			}
			if _, err := s.Pool.Exec(ctx, test.mutation); err != nil {
				t.Fatal(err)
			}
			id := uuid.NewString()
			completion, err := s.WriteWebhook(ctx, endpoint.Owner, id, func(scope store.WebhookWriteScope) error {
				dao := scope.WebhookDAO()
				if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: endpoint.Owner, ActorUserID: actor.UserID, EndpointID: endpoint.ID}); err != nil {
					return err
				}
				if err := dao.ReserveOperation(ctx, endpoint.Owner, time.Now()); err != nil {
					return err
				}
				return dao.ReserveConfiguration(ctx, endpoint.Owner, store.WebhookChangeCost{Records: 1, Bytes: 2048, ActiveRecords: 1, ActiveBytes: 2048})
			})
			var fault *model.Fault
			if !errors.As(err, &fault) || fault.Code != test.code || completion.Outcome != store.TransactionNotCommitted {
				t.Fatalf("capacity refusal: %v %#v", err, completion)
			}
			var count int
			if err := s.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_operations WHERE operation_id=$1`, id).Scan(&count); err != nil || count != 0 {
				t.Fatalf("capacity refusal left a receipt: %d %v", count, err)
			}
		})
	}
	t.Run("expired receipts release coordinated slots", func(t *testing.T) {
		s, actor, _, project := membershipFixture(t)
		ctx := context.Background()
		endpoint := storedWebhook(t, actor, project)
		receipt := webhookReceipt(endpoint, uuid.NewString())
		if _, err := s.WriteWebhook(ctx, endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error { return insertStoredWebhook(ctx, scope, endpoint, receipt) }); err != nil {
			t.Fatal(err)
		}
		past := time.Now().UTC().Add(-31 * 24 * time.Hour)
		if _, err := s.Pool.Exec(ctx, `UPDATE webhook_operations SET recorded_at=$1,expires_at=$2`, past, past.Add(time.Hour)); err != nil {
			t.Fatal(err)
		}
		next := webhookReceipt(endpoint, uuid.NewString())
		next.Kind = wh.EndpointPatch
		next.Effect = wh.EffectUnchanged
		if _, err := s.WriteWebhook(ctx, endpoint.Owner, next.OperationID, func(scope store.WebhookWriteScope) error {
			dao := scope.WebhookDAO()
			if err := dao.LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: endpoint.Owner, ActorUserID: actor.UserID, EndpointID: endpoint.ID}); err != nil {
				return err
			}
			if err := dao.ReserveOperation(ctx, endpoint.Owner, next.RecordedAt); err != nil {
				return err
			}
			return dao.InsertOperation(ctx, next)
		}); err != nil {
			t.Fatal(err)
		}
		var retained, ownerSlots, bucketSlots int
		if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_operations),q.operations_used,b.operations_used FROM webhook_quota_owners q JOIN webhook_quota_buckets b ON b.bucket=q.bucket`).Scan(&retained, &ownerSlots, &bucketSlots); err != nil {
			t.Fatal(err)
		}
		if retained != 1 || ownerSlots != 1 || bucketSlots != 1 {
			t.Fatalf("expired receipt accounting: retained=%d owner=%d bucket=%d", retained, ownerSlots, bucketSlots)
		}
	})
}

func TestWebhookSourceFenceWaitsAndMissingHistoricalScopeCanBeCleaned(t *testing.T) {
	s, actor, _, project := membershipFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	lock, err := s.Pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(context.Background())
	if _, err := lock.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	missing := uuid.NewString()
	go func() {
		_, err := s.WriteWebhook(ctx, wh.Owner{Kind: wh.PersonalOwner, ID: actor.UserID}, uuid.NewString(), func(scope store.WebhookWriteScope) error {
			if err := scope.WebhookDAO().LockConfiguration(ctx, store.WebhookConfigurationLock{Owner: wh.Owner{Kind: wh.PersonalOwner, ID: actor.UserID}, ActorUserID: actor.UserID, ProjectIDs: []string{project.ID, missing}, RequiredProjectIDs: []string{project.ID}, Expansion: true}); err != nil {
				return err
			}
			facts, err := scope.WebhookDAO().Projects(ctx, wh.Owner{Kind: wh.PersonalOwner, ID: actor.UserID}, actor.UserID, []string{project.ID, missing})
			if err == nil && (len(facts) != 2 || !facts[0].CanRead || facts[1].Present) {
				return errors.New("wrong source presence after fence")
			}
			return err
		})
		done <- err
	}()
	waitTransferTeamLock(t, ctx, s, "SELECT id::text FROM projects", lock.Conn().PgConn().PID())
	if err := lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestWebhookCorruptPolicyAndOwnershipAreExposed(t *testing.T) {
	for _, test := range []struct{ name, mutation string }{
		{"checksum", `UPDATE webhook_policies SET sha256=decode(repeat('00',32),'hex')`},
		{"supported parameters", `UPDATE webhook_policies SET parameters=convert_to('{"version":1}','UTF8'),sha256=sha256(convert_to('{"version":1}','UTF8'))`},
		{"unknown parameters", `UPDATE webhook_policies SET parameters=convert_to('{"version":1,"unknown":true}','UTF8'),sha256=sha256(convert_to('{"version":1,"unknown":true}','UTF8'))`},
	} {
		t.Run(test.name, func(t *testing.T) {
			s := isolatedStore(t)
			ctx := context.Background()
			if _, err := s.Pool.Exec(ctx, test.mutation); err != nil {
				t.Fatal(err)
			}
			err := s.ReadSnapshot(ctx, func(scope store.SnapshotScope) error { _, err := scope.WebhookDAO().Policy(ctx); return err })
			if err == nil {
				t.Fatal("damaged policy was accepted")
			}
		})
	}
	t.Run("live Project missing ownership", func(t *testing.T) {
		s, actor, _, project := membershipFixture(t)
		ctx := context.Background()
		if _, err := s.Pool.Exec(ctx, `DELETE FROM project_ownership WHERE project_id=$1`, project.ID); err != nil {
			t.Fatal(err)
		}
		err := s.ReadSnapshot(ctx, func(scope store.SnapshotScope) error {
			_, err := scope.WebhookDAO().Projects(ctx, wh.Owner{Kind: wh.PersonalOwner, ID: actor.UserID}, actor.UserID, []string{project.ID})
			return err
		})
		failed, _ := store.DatabaseErrorFacts(err)
		if err == nil || errors.Is(err, model.ErrNotFound) || !failed {
			t.Fatalf("ownership damage became normal permission loss: %v", err)
		}
	})
}

func TestWebhookOversizedMetadataRollsBackReceiptReservation(t *testing.T) {
	s, actor, _, project := membershipFixture(t)
	ctx := context.Background()
	endpoint := storedWebhook(t, actor, project)
	endpoint.DestinationOrigin = "https://" + strings.Repeat("a", 3000) + ".example"
	receipt := webhookReceipt(endpoint, uuid.NewString())
	completion, err := s.WriteWebhook(ctx, endpoint.Owner, receipt.OperationID, func(scope store.WebhookWriteScope) error { return insertStoredWebhook(ctx, scope, endpoint, receipt) })
	if err == nil || completion.Outcome != store.TransactionNotCommitted {
		t.Fatalf("metadata overflow was accepted: %#v %v", completion, err)
	}
	var endpoints, operations, reserved int64
	if err := s.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations),(SELECT sum(operations_used) FROM webhook_quota_buckets)`).Scan(&endpoints, &operations, &reserved); err != nil {
		t.Fatal(err)
	}
	if endpoints != 0 || operations != 0 || reserved != 0 {
		t.Fatalf("metadata refusal left partial effect: endpoints=%d operations=%d reserved=%d", endpoints, operations, reserved)
	}
}
