package webhook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

func TestWebhookOperationLogsSafeIdentity(t *testing.T) {
	var logs bytes.Buffer
	mux := http.NewServeMux()
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	(&Routes{service: &historyFake{}, auth: fakeAuth{}, logger: logger}).RegisterRoutes(mux)
	handler := httpx.RequestLogging(logger, mux)
	if w := request(handler, "POST", "/api/v1/me/webhooks", createBody("https://example.test/private?token=secret")); w.Code != 201 {
		t.Fatalf("create status %d", w.Code)
	}
	body := fmt.Sprintf(`{"operationId":"%s","issuedAt":"2026-11-07T08:00:00Z","expectedUserId":"%s","ifVersion":"1","ifGeneration":"1"}`, operationID, userID)
	path := "/api/v1/me/webhooks/" + endpointID + "/deliveries/" + deliveryID + "/redeliveries"
	if w := request(handler, "POST", path, body); w.Code != 202 {
		t.Fatalf("redelivery status %d", w.Code)
	}
	if strings.Contains(logs.String(), "private") || strings.Contains(logs.String(), "secret") {
		t.Fatal("destination leaked into logs")
	}
	lines := strings.Split(strings.TrimSpace(logs.String()), "\n")
	i := 0
	for _, line := range lines {
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			t.Fatal(err)
		}
		if entry["msg"] != "webhook operation" {
			continue
		}
		if i >= 2 {
			t.Fatal("unexpected operation log")
		}
		if entry["operation_id"] != operationID || entry["user_id"] != userID || entry["owner_id"] != userID || entry["owner_kind"] != "personal" || entry["phase"] != []string{"endpoint.create", "delivery.redeliver"}[i] {
			t.Fatalf("incorrect operation identity: %v", entry)
		}
		if id, ok := entry["request_id"].(string); !ok || !httpx.ValidRequestID(id) {
			t.Fatal("invalid request identity")
		}
		if i == 1 && (entry["endpoint_id"] != endpointID || entry["delivery_id"] != deliveryID) {
			t.Fatalf("redelivery identities missing: %v", entry)
		}
		i++
	}
	if i != 2 {
		t.Fatalf("operation log count %d", i)
	}
}
