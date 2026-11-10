package webhook

import (
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

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
	s := newReceiptGCPlan(t,
		receiptGCCall{method: "observe", id: id, expires: time.Time{}, present: false, err: cause},
		receiptGCCall{method: "observe", id: id, expires: time.Time{}, present: false},
	)
	collector := &ReceiptCollector{unknown: &id}
	var unresolved *ReceiptGCUnknownError
	if err := collector.Reconcile(s.ctx, s); !errors.As(err, &unresolved) || !errors.Is(err, cause) || unresolved.Identity != id || s.count("observe") != 1 || collector.unknown == nil || *collector.unknown != id {
		t.Fatalf("failed readback lost identity: %v", err)
	}
	s.checkPosition(1)
	if err := collector.Reconcile(s.ctx, s); err != nil || s.count("observe") != 2 || collector.unknown != nil {
		t.Fatalf("successful readback did not resolve: %v", err)
	}
	s.checkPosition(2)
	if err := collector.Reconcile(s.ctx, s); err != nil || s.count("observe") != 2 {
		t.Fatalf("unexpected extra readback: %v", err)
	}
}
