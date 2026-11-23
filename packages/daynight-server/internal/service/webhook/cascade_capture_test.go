package webhook

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
)

func TestCaptureStatusBatchFreezesOnceAndSavesEachTask(t *testing.T) {
	first := captureFact(protocol.StatusChanged)
	second := first
	second.TaskID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, protocol.StatusChanged)}, 2)
	if err := (&Capturer{Random: &captureEntropy{}}).CaptureStatusBatch(t.Context(), dao, captureActor, []protocol.Fact{first, second}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(dao.types, []string{protocol.StatusChanged}) || len(dao.writes) != 2 || dao.writes[0].event.TaskID != first.TaskID || dao.writes[1].event.TaskID != second.TaskID {
		t.Fatalf("capture = %+v", dao)
	}
}

func TestCaptureStatusBatchRejectsInvalidInputAndEmptyAudience(t *testing.T) {
	first := captureFact(protocol.StatusChanged)
	other := first
	other.TaskID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	for _, facts := range [][]protocol.Fact{nil, {first, first}, {first, captureFact(protocol.Created)}} {
		dao := newCaptureDAOMock(t)
		if err := (&Capturer{}).CaptureStatusBatch(t.Context(), dao, captureActor, facts); err == nil {
			t.Fatal("accepted invalid status batch")
		}
	}
	dao := newCaptureDAOMock(t, "freeze")
	dao.freeze = func(context.Context, string, []string) ([]store.WebhookAudience, error) { return nil, nil }
	if err := (&Capturer{}).CaptureStatusBatch(t.Context(), dao, captureActor, []protocol.Fact{first, other}); err != nil || len(dao.writes) != 0 {
		t.Fatalf("empty audience: %v, writes %d", err, len(dao.writes))
	}
}

func TestCaptureStatusBatchReturnsLatePersistenceFailure(t *testing.T) {
	first := captureFact(protocol.StatusChanged)
	second := first
	second.TaskID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, protocol.StatusChanged)}, 2)
	cause := errors.New("second capture failed")
	original := dao.save
	count := 0
	dao.save = func(ctx context.Context, event store.WebhookCapturedEvent, deliveries []store.WebhookCapturedDelivery) error {
		count++
		if count == 2 {
			return cause
		}
		return original(ctx, event, deliveries)
	}
	if err := (&Capturer{Random: &captureEntropy{}}).CaptureStatusBatch(t.Context(), dao, captureActor, []protocol.Fact{first, second}); !errors.Is(err, cause) {
		t.Fatalf("error = %v", err)
	}
}
