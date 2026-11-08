package webhook

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

type redeliveryWireService struct {
	historyFake
	testing  *testing.T
	response any
	actor    model.Principal
	endpoint string
	delivery string
}

func (s *redeliveryWireService) Redeliver(_ context.Context, p model.Principal, o Owner, endpoint, delivery string, input webhookservice.Redelivery) (webhookservice.Result, error) {
	if s.response == nil && s.err == nil {
		s.testing.Fatal("unexpected redelivery without a configured result")
	}
	s.calls++
	s.actor, s.owner, s.endpoint, s.delivery, s.input = p, o, endpoint, delivery, input
	return webhookservice.Result{Body: s.response, Replay: s.replay}, s.err
}

func redeliveryWireHandler(s *redeliveryWireService, output io.Writer) http.Handler {
	logger := slog.New(slog.NewJSONHandler(output, nil))
	mux := http.NewServeMux()
	(&Routes{service: s, auth: fakeAuth{}, logger: logger}).RegisterRoutes(mux)
	return httpx.RequestLogging(logger, mux)
}

func redeliveryWireBody() string {
	return fmt.Sprintf(`{"operationId":%q,"issuedAt":"2026-11-07T08:00:00.123400Z","expectedUserId":%q,"ifVersion":"9223372036854775807","ifGeneration":"4"}`, operationID, userID)
}

func TestRedeliveryWireFaultsPreserveRequestAndCorrelation(t *testing.T) {
	for _, scenario := range []struct {
		code   string
		status int
	}{
		{"delivery_stopped", http.StatusConflict},
		{"generation_conflict", http.StatusConflict},
		{"target_changed", http.StatusConflict},
		{"payload_expired", http.StatusGone},
		{"operation_expired", http.StatusGone},
		{"operation_conflict", http.StatusConflict},
		{"not_found", http.StatusNotFound},
	} {
		t.Run(scenario.code, func(t *testing.T) {
			var logs bytes.Buffer
			s := &redeliveryWireService{testing: t}
			s.err = &model.Fault{Code: scenario.code}
			body := redeliveryWireBody()
			r := httptest.NewRequest(http.MethodPost, "/api/v1/me/webhooks/"+endpointID+"/deliveries/"+deliveryID+"/redeliveries", strings.NewReader(body))
			r.Header.Set("Content-Type", "application/json")
			r.Header.Set("X-Request-ID", "redelivery-wire-request")
			w := httptest.NewRecorder()
			redeliveryWireHandler(s, &logs).ServeHTTP(w, r)
			if w.Code != scenario.status || code(t, w) != scenario.code {
				t.Fatalf("fault response: status=%d body=%s", w.Code, w.Body)
			}
			digest := sha256.Sum256([]byte(body))
			if s.calls != 1 || s.actor.UserID != userID || s.owner.Kind != "personal" || s.owner.ID != userID || s.endpoint != endpointID || s.delivery != deliveryID || s.input.OperationID != operationID || s.input.ExpectedUserID != userID || s.input.IfVersion != 9223372036854775807 || s.input.IfGeneration != 4 || s.input.RequestSHA256 != hex.EncodeToString(digest[:]) {
				t.Fatalf("redelivery input: calls=%d service=%+v", s.calls, s)
			}
			if w.Header().Get("Daynight-User-ID") != userID || w.Header().Get("Cache-Control") != "no-store" || w.Header().Get("X-Request-ID") != "redelivery-wire-request" {
				t.Fatalf("response identity: %v", w.Header())
			}
			for _, value := range []string{userID, endpointID, deliveryID, operationID, "redelivery-wire-request", scenario.code} {
				if !strings.Contains(logs.String(), value) {
					t.Fatalf("missing redelivery correlation %q: %s", value, logs.String())
				}
			}
		})
	}
}

func TestExpiredOperationWireReadIsNotFound(t *testing.T) {
	s := &fakeService{err: &model.Fault{Code: "not_found"}}
	w := request(fixture(s, io.Discard), http.MethodGet, "/api/v1/me/webhooks/operations/"+operationID, "")
	if w.Code != http.StatusNotFound || code(t, w) != "not_found" || s.calls != 1 || s.read != "operation" || s.id != operationID || s.owner.Kind != "personal" || s.owner.ID != userID {
		t.Fatalf("expired operation response: status=%d body=%s service=%+v", w.Code, w.Body, s)
	}
	if w.Header().Get("Daynight-User-ID") != userID || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("expired operation response identity: %v", w.Header())
	}
}

func TestRedeliveryWireReplayReturnsCanonicalOperation(t *testing.T) {
	for _, replay := range []bool{false, true} {
		t.Run(fmt.Sprint(replay), func(t *testing.T) {
			s := &redeliveryWireService{testing: t, response: map[string]any{"operation": map[string]any{"operationId": operationID}, "delivery": map[string]any{"id": deliveryID, "generation": "5"}}}
			s.replay = replay
			w := request(redeliveryWireHandler(s, io.Discard), http.MethodPost, "/api/v1/me/webhooks/"+endpointID+"/deliveries/"+deliveryID+"/redeliveries", redeliveryWireBody())
			var value struct {
				Operation struct {
					OperationID string `json:"operationId"`
				} `json:"operation"`
				Delivery struct {
					ID         string `json:"id"`
					Generation string `json:"generation"`
				} `json:"delivery"`
			}
			if w.Code != http.StatusAccepted || json.Unmarshal(w.Body.Bytes(), &value) != nil || value.Operation.OperationID != operationID || value.Delivery.ID != deliveryID || value.Delivery.Generation != "5" || s.calls != 1 {
				t.Fatalf("canonical redelivery response: status=%d body=%s calls=%d", w.Code, w.Body, s.calls)
			}
		})
	}
}

func TestRedeliveryWireCompletionFailuresRedactCauses(t *testing.T) {
	const canary = "private-destination-token-payload-signing-secret"
	for _, scenario := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"database", &store.Error{DatabaseFailure: true, Cause: errors.New(canary)}, http.StatusServiceUnavailable, "dependency_unavailable"},
		{"cleanup", &model.Fault{Code: "forbidden", Cause: &store.TransactionError{Phase: "rollback", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New(canary)}}, http.StatusInternalServerError, "internal_error"},
		{"unknown", &model.Fault{Code: "write_outcome_unknown", Cause: &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, Cause: &store.Error{DatabaseFailure: true, Cause: errors.New(canary)}}}, http.StatusServiceUnavailable, "write_outcome_unknown"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var logs bytes.Buffer
			s := &redeliveryWireService{testing: t}
			s.err = scenario.err
			w := request(redeliveryWireHandler(s, &logs), http.MethodPost, "/api/v1/me/webhooks/"+endpointID+"/deliveries/"+deliveryID+"/redeliveries", redeliveryWireBody())
			if w.Code != scenario.status || code(t, w) != scenario.code || s.calls != 1 {
				t.Fatalf("completion response: status=%d body=%s calls=%d", w.Code, w.Body, s.calls)
			}
			if strings.Contains(w.Body.String(), canary) || strings.Contains(logs.String(), canary) {
				t.Fatalf("private completion cause leaked: body=%s logs=%s", w.Body, logs.String())
			}
		})
	}
}
