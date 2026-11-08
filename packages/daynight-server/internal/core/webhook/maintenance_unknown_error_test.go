package webhook

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type receiptReconcileFailure struct {
	receiptGCStub
	failure error
}

func (s *receiptReconcileFailure) ObserveWebhookReceipt(context.Context, store.WebhookReceiptIdentity) (time.Time, bool, error) {
	s.observed++
	return time.Time{}, false, s.failure
}

func TestMaintenanceUnknownErrorsAndReceiptReconciliation(t *testing.T) {
	cause := errors.New("readback unavailable")
	config := &ConfigGCUnknownError{Identity: store.WebhookConfigGCCandidate{Kind: "binding", ID: "original"}, Cause: cause}
	if config.Error() != "webhook configuration collection outcome unknown" || !errors.Is(config, cause) {
		t.Fatalf("configuration error lost its safe message or cause: %v", config)
	}
	receipt := &ReceiptGCUnknownError{Identity: store.WebhookReceiptIdentity{OperationID: "original"}, Cause: cause}
	if receipt.Error() != "webhook receipt collection outcome unknown" || !errors.Is(receipt, cause) {
		t.Fatalf("receipt error lost its safe message or cause: %v", receipt)
	}
	id := receipt.Identity
	s := &receiptReconcileFailure{failure: cause}
	collector := &ReceiptCollector{unknown: &id}
	var unresolved *ReceiptGCUnknownError
	if err := collector.Reconcile(context.Background(), s); !errors.As(err, &unresolved) || !errors.Is(err, cause) || unresolved.Identity != id || s.observed != 1 || collector.unknown == nil {
		t.Fatalf("failed readback lost identity: %v", err)
	}
	s.failure = nil
	if err := collector.Reconcile(context.Background(), s); err != nil || s.observed != 2 || collector.unknown != nil {
		t.Fatalf("successful readback did not resolve: %v", err)
	}
	if err := collector.Reconcile(context.Background(), s); err != nil || s.observed != 2 {
		t.Fatalf("unexpected extra readback: %v", err)
	}
}
