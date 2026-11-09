package webhook

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/google/uuid"
)

func captureLog(t *testing.T, logs *bytes.Buffer) map[string]any {
	t.Helper()
	var entry map[string]any
	if err := json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &entry); err != nil {
		t.Fatalf("capture log: %v: %s", err, logs.String())
	}
	for _, sensitive := range []string{"receiver.example", "/hook", "token=private", "secret task title", "specversion", "destination_configuration"} {
		if strings.Contains(logs.String(), sensitive) {
			t.Fatalf("capture log leaked %q: %s", sensitive, logs.String())
		}
	}
	return entry
}

func TestCapturePreparedLogUsesRecordedIdentities(t *testing.T) {
	dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, protocol.Created)}, 1)
	var logs bytes.Buffer
	request := strings.Repeat("r", 128)
	ctx := requestid.With(t.Context(), request)
	c := &Capturer{Random: &captureEntropy{}, Logger: slog.New(slog.NewJSONHandler(&logs, nil)), RequestID: requestid.From}
	if err := c.CaptureBatch(ctx, dao, []protocol.Fact{captureFact(protocol.Created)}); err != nil {
		t.Fatal(err)
	}
	event, delivery := dao.writes[0].event, dao.writes[0].deliveries[0]
	entry := captureLog(t, &logs)
	for key, want := range map[string]string{"msg": "webhook responsibility prepared", "component": "webhook", "phase": "persist", "event_id": event.ID, "delivery_id": delivery.ID, "endpoint_id": captureEndpointID, "project_id": captureProjectID, "owner_kind": "personal", "owner_id": captureOwnerID, "origin_request_id": request} {
		if entry[key] != want {
			t.Fatalf("%s = %v, want %s", key, entry[key], want)
		}
	}
	if event.OriginRequestID == nil || *event.OriginRequestID != request || requestid.From(dao.writes[0].context) != request || entry["schema_version"] != float64(1) || entry["adapter_version"] != float64(1) {
		t.Fatal("request context or version correlation lost")
	}
}

func TestCaptureLogsActualEventAndScheduleEntropyFailure(t *testing.T) {
	dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, protocol.Created)}, 0)
	var logs bytes.Buffer
	cause := errors.New("entropy failed at https://receiver.example/hook?token=private")
	c := &Capturer{Random: &captureFailedEntropy{cause: cause, jitterFailure: true}, Logger: slog.New(slog.NewJSONHandler(&logs, nil)), RequestID: requestid.From}
	ctx := requestid.With(t.Context(), "capture-test-request")
	if err := c.CaptureBatch(ctx, dao, []protocol.Fact{captureFact(protocol.Created)}); !errors.Is(err, cause) {
		t.Fatalf("lost entropy cause: %v", err)
	}
	entry := captureLog(t, &logs)
	for key, want := range map[string]string{"msg": "webhook capture failed", "component": "webhook", "phase": "capture", "error_kind": "capture_failed", "endpoint_id": captureEndpointID, "project_id": captureProjectID, "owner_kind": "personal", "owner_id": captureOwnerID, "origin_request_id": "capture-test-request"} {
		if entry[key] != want {
			t.Fatalf("%s = %v, want %s", key, entry[key], want)
		}
	}
	for _, key := range []string{"event_id", "delivery_id"} {
		id, ok := entry[key].(string)
		if !ok || uuid.Validate(id) != nil {
			t.Fatalf("invalid %s: %v", key, entry[key])
		}
	}
	if len(dao.writes) != 0 {
		t.Fatal("entropy failure requested persistence")
	}
}

func TestCaptureFailureLogsKeepSafePhaseAndRequest(t *testing.T) {
	for _, phase := range []string{"freeze", "persist"} {
		t.Run(phase, func(t *testing.T) {
			dao := captureSuccessfulDAO(t, []store.WebhookAudience{captureAudience(t, protocol.Created)}, 1)
			cause := errors.New("https://receiver.example/hook?token=private secret task title")
			if phase == "freeze" {
				dao.want = []string{"freeze"}
				dao.freeze = func(context.Context, string, []string) ([]store.WebhookAudience, error) { return nil, cause }
			} else {
				dao.save = func(context.Context, store.WebhookCapturedEvent, []store.WebhookCapturedDelivery) error { return cause }
			}
			var logs bytes.Buffer
			c := &Capturer{Random: &captureEntropy{}, Logger: slog.New(slog.NewJSONHandler(&logs, nil)), RequestID: requestid.From}
			if err := c.CaptureBatch(requestid.With(t.Context(), "capture-failure-request"), dao, []protocol.Fact{captureFact(protocol.Created)}); !errors.Is(err, cause) {
				t.Fatalf("lost storage cause: %v", err)
			}
			entry := captureLog(t, &logs)
			if entry["phase"] != phase || entry["origin_request_id"] != "capture-failure-request" || entry["error_kind"] != "capture_failed" || entry["project_id"] != captureProjectID {
				t.Fatalf("failure correlation = %v", entry)
			}
		})
	}
}

func TestCaptureCancelledContextKeepsRequestCorrelation(t *testing.T) {
	ctx, cancel := context.WithCancel(requestid.With(t.Context(), "cancelled-capture-request"))
	cancel()
	dao := newCaptureDAOMock(t, "freeze")
	dao.freeze = func(ctx context.Context, _ string, _ []string) ([]store.WebhookAudience, error) {
		return nil, ctx.Err()
	}
	var logs bytes.Buffer
	c := &Capturer{Logger: slog.New(slog.NewJSONHandler(&logs, nil)), RequestID: requestid.From}
	if err := c.CaptureBatch(ctx, dao, []protocol.Fact{captureFact(protocol.Created)}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled cause = %v", err)
	}
	entry := captureLog(t, &logs)
	if entry["origin_request_id"] != "cancelled-capture-request" || entry["project_id"] != captureProjectID || entry["phase"] != "freeze" {
		t.Fatal(entry)
	}
}
