package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func captureBoundaryRecords(t *testing.T, ctx context.Context, tx pgx.Tx, id string, size int) (store.WebhookCapturedEvent, store.WebhookCapturedDelivery) {
	t.Helper()
	dao := New(tx)
	sources, err := dao.AdmissionSources(ctx, id, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	original, err := dao.LockDelivery(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	body := bytes.Repeat([]byte{'x'}, size)
	hash := sha256.Sum256(body)
	proofs := make([]store.WebhookCapturedMatch, len(sources.Matches))
	for i, m := range sources.Matches {
		proofs[i] = m.WebhookCapturedMatch
	}
	event := sources.Event
	prepared := store.WebhookCapturedDelivery{ID: uuid.NewString(), EndpointID: original.EndpointID, Owner: original.Owner, OriginalMatchSHA256: original.OriginalMatchSHA256, PolicyVersion: original.PolicyVersion, DestinationRevision: original.DestinationRevision, AdapterVersion: original.AdapterVersion, DestinationKind: original.DestinationKind, DestinationOrigin: original.DestinationOrigin, RenderVersion: original.RenderVersion, ConfigurationSchemaVersion: original.ConfigurationSchemaVersion, DestinationConfiguration: original.DestinationConfiguration, RequestMethod: original.RequestMethod, RequestMediaType: original.RequestMediaType, DeterministicHeadersJSON: original.DeterministicHeadersJSON, Body: body, BodySHA256: hash[:], AutomaticScheduleAt: original.AutomaticScheduleAt, AutomaticExpiresAt: original.AutomaticExpiresAt, PayloadExpiresAt: original.PayloadExpiresAt, LastActivityAt: original.LastActivityAt, MetadataExpiresAt: original.MetadataExpiresAt, Matches: proofs}
	return event, prepared
}

func TestCaptureBodyCapacityIsEnforcedByPostgreSQL(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx := t.Context()
	for _, size := range []int{65536, 65537} {
		tx, err := f.conn.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		event, delivery := captureBoundaryRecords(t, ctx, tx, f.delivery, size)
		event.ID = uuid.NewString()
		err = New(tx).SaveCapture(ctx, event, []store.WebhookCapturedDelivery{delivery})
		if size == 65536 {
			if err != nil {
				t.Fatalf("legal body capacity rejected: %v", err)
			}
			if err = tx.Commit(ctx); err != nil {
				t.Fatal(err)
			}
			var body, hash []byte
			var originalBytes int
			if err = f.conn.QueryRow(ctx, `SELECT body,body_sha256,original_body_bytes FROM webhook_deliveries WHERE id=$1`, delivery.ID).Scan(&body, &hash, &originalBytes); err != nil || originalBytes != size || !bytes.Equal(body, delivery.Body) || !bytes.Equal(hash, delivery.BodySHA256) {
				t.Fatalf("legal capture bytes changed: length=%d original=%d error=%v", len(body), originalBytes, err)
			}
		} else {
			failed, state := store.DatabaseErrorFacts(err)
			if !failed || state != "23514" {
				t.Fatalf("oversize body error lost SQL boundary: %q %v", state, err)
			}
			if err = tx.Rollback(ctx); err != nil {
				t.Fatal(err)
			}
			var events, deliveries int
			if err = f.conn.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE id=$1),(SELECT count(*) FROM webhook_deliveries WHERE id=$2)`, event.ID, delivery.ID).Scan(&events, &deliveries); err != nil || events != 0 || deliveries != 0 {
				t.Fatalf("rejected body persisted partial records: events=%d deliveries=%d error=%v", events, deliveries, err)
			}
		}
	}
}

func TestCaptureRejectsDuplicateEventWithoutAddingResponsibilities(t *testing.T) {
	f := newDeliveryFailureFixture(t)
	ctx := t.Context()
	tx, err := f.conn.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	event, delivery := captureBoundaryRecords(t, ctx, tx, f.delivery, 2)
	err = New(tx).SaveCapture(ctx, event, []store.WebhookCapturedDelivery{delivery})
	failed, state := store.DatabaseErrorFacts(err)
	if !failed || state != "23505" {
		t.Fatalf("duplicate event was not a unique-key failure: %q %v", state, err)
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	var original, newDeliveries int
	if err = f.conn.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_deliveries WHERE id=$1),(SELECT count(*) FROM webhook_deliveries WHERE id=$2)`, f.delivery, delivery.ID).Scan(&original, &newDeliveries); err != nil || original != 1 || newDeliveries != 0 {
		t.Fatalf("duplicate event changed responsibilities: original=%d new=%d error=%v", original, newDeliveries, err)
	}
}
