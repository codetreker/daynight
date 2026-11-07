package webhook_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/google/uuid"
)

type loggingFailedEntropy struct{ err error }

func (r loggingFailedEntropy) Read([]byte) (int, error) { return 0, r.err }

func TestCaptureLogsActualEventAndEncryptionFailure(t *testing.T) {
	f := newCaptureFixture(t, 1)
	var logs bytes.Buffer
	f.capture.Logger = slog.New(slog.NewJSONHandler(&logs, nil))
	f.capture.RequestID = requestid.From
	req := "capture-test-request"
	ctx := requestid.With(f.ctx, req)
	tasks := taskservice.NewTasks(f.db, f.capture)
	task, err := tasks.Create(ctx, f.principal, f.project, taskcore.CreateTask{Title: "secret task title"})
	if err != nil {
		t.Fatal(err)
	}
	var eventID, deliveryID, endpointID string
	if err = f.db.Pool.QueryRow(ctx, `SELECT e.id::text,d.id::text,d.endpoint_id::text FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1`, task.ID).Scan(&eventID, &deliveryID, &endpointID); err != nil {
		t.Fatal(err)
	}
	var success map[string]any
	if err = json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &success); err != nil {
		t.Fatalf("success log: %v: %s", err, logs.String())
	}
	for key, want := range map[string]string{"event_id": eventID, "delivery_id": deliveryID, "endpoint_id": endpointID, "project_id": f.project, "owner_id": f.principal.UserID, "origin_request_id": req, "phase": "persist"} {
		if success[key] != want {
			t.Fatalf("success %s=%v want %s", key, success[key], want)
		}
	}
	assertSafeCaptureLog(t, logs.String())
	logs.Reset()
	failure := errors.New("synthetic entropy failure")
	// The two UUID reads succeed; the subsequent nonce read in Seal fails.
	f.capture.Random = io.MultiReader(bytes.NewReader(bytes.Repeat([]byte{1}, 32)), loggingFailedEntropy{failure})
	_, err = tasks.Create(ctx, f.principal, f.project, taskcore.CreateTask{Title: "secret task title"})
	if !errors.Is(err, failure) {
		t.Fatalf("encryption failure not preserved: %v", err)
	}
	var failed map[string]any
	if err = json.Unmarshal(bytes.TrimSpace(logs.Bytes()), &failed); err != nil {
		t.Fatalf("failure log: %v: %s", err, logs.String())
	}
	candidate, ok := failed["event_id"].(string)
	if !ok || uuid.Validate(candidate) != nil {
		t.Fatalf("invalid event ID in failure log: %v", failed)
	}
	for key, want := range map[string]string{"endpoint_id": endpointID, "project_id": f.project, "owner_id": f.principal.UserID, "origin_request_id": req, "error_kind": "capture_failed"} {
		if failed[key] != want {
			t.Fatalf("failure %s=%v want %s", key, failed[key], want)
		}
	}
	if failed["delivery_id"] == "" {
		t.Fatalf("missing candidate delivery ID: %v", failed)
	}
	var committed int
	if err = f.db.Pool.QueryRow(context.Background(), `SELECT count(*) FROM webhook_events WHERE id=$1`, candidate).Scan(&committed); err != nil || committed != 0 {
		t.Fatalf("failed event committed=%d err=%v", committed, err)
	}
	assertSafeCaptureLog(t, logs.String())
}

func assertSafeCaptureLog(t *testing.T, log string) {
	t.Helper()
	for _, secret := range []string{"receiver.example", "/hook", "secret task title", "specversion", "destination_ciphertext"} {
		if strings.Contains(log, secret) {
			t.Fatalf("log contains %q: %s", secret, log)
		}
	}
}
