package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

const deliveryID = "55555555-5555-4555-8555-555555555555"

type historyFake struct {
	fakeService
	input         webhookservice.Redelivery
	deliveryQuery webhookservice.DeliveryQuery
	attemptQuery  webhookservice.AttemptQuery
}

func (s *historyFake) ListDeliveries(_ context.Context, _ model.Principal, _ Owner, _ string, q webhookservice.DeliveryQuery) (any, error) {
	s.calls++
	s.deliveryQuery = q
	return map[string]any{"items": []any{}}, s.err
}
func (s *historyFake) GetDelivery(_ context.Context, _ model.Principal, _ Owner, _, _ string) (any, error) {
	s.calls++
	return map[string]any{}, s.err
}
func (s *historyFake) ListAttempts(_ context.Context, _ model.Principal, _ Owner, _, _ string, q webhookservice.AttemptQuery) (any, error) {
	s.calls++
	s.attemptQuery = q
	return map[string]any{"items": []any{}}, s.err
}
func (s *historyFake) Payload(_ context.Context, _ model.Principal, _ Owner, _, _ string) (any, error) {
	s.calls++
	return map[string]any{}, s.err
}
func (s *historyFake) Redeliver(_ context.Context, _ model.Principal, _ Owner, _, _ string, m webhookservice.Redelivery) (webhookservice.Result, error) {
	s.calls++
	s.input = m
	return webhookservice.Result{Body: map[string]any{}}, s.err
}
func historyFixture(s *historyFake) http.Handler {
	mux := http.NewServeMux()
	(&Routes{service: s, auth: fakeAuth{}, logger: slog.New(slog.NewJSONHandler(io.Discard, nil))}).RegisterRoutes(mux)
	return mux
}

func TestHistoryRoutesValidateFiltersAndMethods(t *testing.T) {
	s := &historyFake{}
	h := historyFixture(s)
	base := "/api/v1/me/webhooks/" + endpointID + "/deliveries"
	for _, path := range []string{base + "?state=unknown", base + "?state=pending&state=failed", base + "?projectId=bad", base + "?from=2026-01-01T00:00:00%2B01:00", base + "?limit=0", base + "/" + deliveryID + "/attempts?generation=01", base + "/" + deliveryID + "/payload?x=1"} {
		w := request(h, "GET", path, "")
		if w.Code != 400 || s.calls != 0 {
			t.Fatalf("%s: %d calls %d", path, w.Code, s.calls)
		}
	}
	w := request(h, "GET", base+"?state=pending&limit=2", "")
	if w.Code != 200 || s.calls != 1 || s.deliveryQuery.State != "pending" || s.deliveryQuery.Limit != 2 {
		t.Fatalf("%d %#v", w.Code, s)
	}
	w = request(h, "POST", base+"/"+deliveryID+"/payload", "")
	if w.Code != 405 || w.Header().Get("Allow") != "GET, HEAD" {
		t.Fatalf("%d %v", w.Code, w.Header())
	}
}
func TestRedeliveryWireIdentityAndDigest(t *testing.T) {
	s := &historyFake{}
	h := historyFixture(s)
	path := "/api/v1/me/webhooks/" + endpointID + "/deliveries/" + deliveryID + "/redeliveries"
	body := fmt.Sprintf(`{"operationId":"%s","issuedAt":"2026-11-07T08:00:00.123400Z","expectedUserId":"%s","ifVersion":"9007199254740993","ifGeneration":"4"}`, operationID, userID)
	w := request(h, "POST", path, body)
	sum := sha256.Sum256([]byte(body))
	if w.Code != 202 || s.calls != 1 || s.input.IfVersion != 9007199254740993 || s.input.IfGeneration != 4 || s.input.RequestSHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("%d %#v", w.Code, s.input)
	}
	for _, bad := range []string{strings.Replace(body, `"ifGeneration":"4"`, `"generation":"4"`, 1), strings.Replace(body, `"ifGeneration":"4"`, `"ifGeneration":"04"`, 1), strings.Replace(body, `"ifVersion":"9007199254740993"`, `"ifVersion":4`, 1)} {
		w = request(h, "POST", path, bad)
		if w.Code != 400 || s.calls != 1 {
			t.Fatalf("%d calls %d", w.Code, s.calls)
		}
	}
	s.err = &model.Fault{Code: "delivery_busy"}
	w = request(h, "POST", path, body)
	if w.Code != 409 || code(t, w) != "delivery_busy" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}

func TestHistoryFailureRedactsDetails(t *testing.T) {
	var logs bytes.Buffer
	s := &historyFake{}
	s.err = fmt.Errorf("destination https://secret.invalid/private?token=credential and payload-marker and Authorization: bearer-value")
	mux := http.NewServeMux()
	(&Routes{service: s, auth: fakeAuth{}, logger: slog.New(slog.NewJSONHandler(&logs, nil))}).RegisterRoutes(mux)
	path := "/api/v1/me/webhooks/" + endpointID + "/deliveries/" + deliveryID + "/payload"
	w := request(mux, "GET", path, "")
	if w.Code != 500 {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	for _, value := range []string{"secret.invalid", "private", "credential", "payload-marker", "bearer-value"} {
		if strings.Contains(w.Body.String(), value) || strings.Contains(logs.String(), value) {
			t.Fatalf("sensitive value appeared in output: %s", value)
		}
	}
	if !strings.Contains(logs.String(), userID) || !strings.Contains(logs.String(), endpointID) || !strings.Contains(logs.String(), deliveryID) || !strings.Contains(logs.String(), "internal_error") {
		t.Fatalf("missing safe correlation: %s", logs.String())
	}
}
