package assistanttask

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/assistanttask"
)

const receivePath = "/api/v1/assistant-task-inbox/" + testID
const receiveToken = "dnib_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"

type receiverFunc func(context.Context, service.ReceiveInput) (service.ReceiveResult, error)

func (f receiverFunc) Receive(ctx context.Context, input service.ReceiveInput) (service.ReceiveResult, error) {
	return f(ctx, input)
}

func receiveHandler(receive receiverFunc, logs io.Writer) http.Handler {
	mux := http.NewServeMux()
	RegisterInboxRoute(mux, receive, slog.New(slog.NewJSONHandler(logs, nil)))
	return mux
}

func receiveRequest(h http.Handler, target, contentType, body string, headers map[string]string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
	if contentType != "" {
		r.Header.Set("Content-Type", contentType)
	}
	for key, value := range headers {
		r.Header.Set(key, value)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func accepted(context.Context, service.ReceiveInput) (service.ReceiveResult, error) {
	id := testTarget
	return service.ReceiveResult{EventID: &id, Classification: "external"}, nil
}

func TestInboxReceiveForwardsRequestAndAnswersReceipt(t *testing.T) {
	token := receiveToken
	for _, test := range []struct {
		name, target, contentType, body string
		headers                         map[string]string
		want                            service.ReceiveInput
	}{
		{"header token", receivePath, "application/json; charset=UTF-8", `{"a":1}`,
			map[string]string{"Authorization": "Bearer " + token, "Idempotency-Key": "key-1"},
			service.ReceiveInput{InboxID: testID, Token: &token, MediaType: "application/json", IdempotencyKey: "key-1", Body: []byte(`{"a":1}`)}},
		{"query token", receivePath + "?token=" + token, "text/plain", "hello",
			nil, service.ReceiveInput{InboxID: testID, Token: &token, MediaType: "text/plain", Body: []byte("hello")}},
		{"no token", receivePath, "application/cloudevents+json", `{"id":"e"}`,
			map[string]string{"Webhook-Id": "e"}, service.ReceiveInput{InboxID: testID, MediaType: "application/cloudevents+json", WebhookID: "e", Body: []byte(`{"id":"e"}`)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			var got service.ReceiveInput
			h := receiveHandler(func(ctx context.Context, input service.ReceiveInput) (service.ReceiveResult, error) {
				got = input
				return accepted(ctx, input)
			}, io.Discard)
			w := receiveRequest(h, test.target, test.contentType, test.body, test.headers)
			if w.Code != http.StatusAccepted || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("status=%d body=%s input=%+v", w.Code, w.Body, got)
			}
			want := `{"eventId":"` + testTarget + `","classification":"external","duplicate":false,"suppressed":false}`
			if strings.TrimSpace(w.Body.String()) != want {
				t.Fatalf("body=%s", w.Body)
			}
		})
	}
	h := receiveHandler(func(context.Context, service.ReceiveInput) (service.ReceiveResult, error) {
		return service.ReceiveResult{Classification: "daynight", Duplicate: true, Suppressed: true}, nil
	}, io.Discard)
	w := receiveRequest(h, receivePath, "application/json", `{}`, nil)
	if w.Code != http.StatusAccepted || strings.TrimSpace(w.Body.String()) != `{"eventId":null,"classification":"daynight","duplicate":true,"suppressed":true}` {
		t.Fatalf("suppressed status=%d body=%s", w.Code, w.Body)
	}
}

func TestInboxReceiveRefusesInvalidRequestsBeforeTheService(t *testing.T) {
	h := receiveHandler(func(context.Context, service.ReceiveInput) (service.ReceiveResult, error) {
		t.Fatal("refused request reached the service")
		return service.ReceiveResult{}, nil
	}, io.Discard)
	bearer := map[string]string{"Authorization": "Bearer " + receiveToken}
	for _, test := range []struct {
		name, target, contentType, body string
		headers                         map[string]string
		status                          int
		code                            string
	}{
		{"noncanonical inbox", "/api/v1/assistant-task-inbox/" + strings.ReplaceAll(testID, "-", ""), "application/json", `{}`, nil, 404, "not_found"},
		{"nil inbox", "/api/v1/assistant-task-inbox/00000000-0000-0000-0000-000000000000", "application/json", `{}`, nil, 404, "not_found"},
		{"header and query", receivePath + "?token=" + receiveToken, "application/json", `{}`, bearer, 400, "invalid_input"},
		{"repeated query", receivePath + "?token=a&token=b", "application/json", `{}`, nil, 400, "invalid_input"},
		{"malformed query", receivePath + "?token=%zz", "application/json", `{}`, nil, 400, "invalid_input"},
		{"basic scheme", receivePath, "application/json", `{}`, map[string]string{"Authorization": "Basic " + receiveToken}, 400, "invalid_input"},
		{"bare scheme", receivePath, "application/json", `{}`, map[string]string{"Authorization": "Bearer"}, 400, "invalid_input"},
		{"empty bearer", receivePath, "application/json", `{}`, map[string]string{"Authorization": "Bearer "}, 400, "invalid_input"},
		{"empty query", receivePath + "?token=", "application/json", `{}`, nil, 400, "invalid_input"},
		{"empty idempotency key", receivePath, "application/json", `{}`, map[string]string{"Authorization": "Bearer " + receiveToken, "Idempotency-Key": ""}, 400, "invalid_input"},
		{"blank idempotency key", receivePath, "application/json", `{}`, map[string]string{"Authorization": "Bearer " + receiveToken, "Idempotency-Key": "  "}, 400, "invalid_input"},
		{"empty webhook id", receivePath, "application/json", `{}`, map[string]string{"Authorization": "Bearer " + receiveToken, "Webhook-Id": ""}, 400, "invalid_input"},
		{"missing media type", receivePath, "", `{}`, nil, 415, "unsupported_media_type"},
		{"html", receivePath, "text/html", `x`, nil, 415, "unsupported_media_type"},
		{"latin1 text", receivePath, "text/plain; charset=latin1", `x`, nil, 415, "unsupported_media_type"},
		{"malformed media type", receivePath, "application/json; charset", `{}`, nil, 415, "unsupported_media_type"},
		{"xml", receivePath, "application/xml", `<a/>`, nil, 415, "unsupported_media_type"},
		{"NUL text", receivePath, "text/plain", "a\x00b", nil, 400, "invalid_input"},
		{"invalid UTF-8 text", receivePath, "text/plain", "a\xffb", nil, 400, "invalid_input"},
		{"invalid UTF-8 JSON", receivePath, "application/json", "\"a\xffb\"", nil, 400, "invalid_input"},
		{"invalid JSON", receivePath, "application/problem+json", `{"a":`, nil, 400, "invalid_input"},
		{"empty JSON", receivePath, "application/json", ``, nil, 400, "invalid_input"},
		{"oversized", receivePath, "text/plain", strings.Repeat("a", InboxBodyLimit+1), nil, 413, "payload_too_large"},
	} {
		t.Run(test.name, func(t *testing.T) {
			w := receiveRequest(h, test.target, test.contentType, test.body, test.headers)
			if w.Code != test.status || !strings.Contains(w.Body.String(), `"code":"`+test.code+`"`) {
				t.Fatalf("status=%d body=%s", w.Code, w.Body)
			}
		})
	}
	r := httptest.NewRequest(http.MethodPost, receivePath, strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Add("Authorization", "Bearer "+receiveToken)
	r.Header.Add("Authorization", "Bearer "+receiveToken)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("repeated header status=%d", w.Code)
	}
	r = httptest.NewRequest(http.MethodPost, receivePath, strings.NewReader(`{}`))
	r.Header["Content-Type"] = []string{"application/json", "text/plain"}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("repeated media type status=%d", w.Code)
	}
	r = httptest.NewRequest(http.MethodPost, receivePath, strings.NewReader(`{}`))
	r.Header.Set("Content-Type", "application/json")
	r.ContentLength = InboxBodyLimit + 1
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("declared length status=%d", w.Code)
	}
	r = httptest.NewRequest(http.MethodPost, receivePath, strings.NewReader(strings.Repeat("a", InboxBodyLimit+1)))
	r.Header.Set("Content-Type", "text/plain")
	r.ContentLength = -1
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("undeclared length status=%d", w.Code)
	}
	r = httptest.NewRequest(http.MethodPost, receivePath, io.MultiReader(strings.NewReader("{"), failingReader{}))
	r.Header.Set("Content-Type", "application/json")
	r.ContentLength = -1
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code < 400 {
		t.Fatalf("failed body read status=%d", w.Code)
	}
	for _, method := range []string{http.MethodGet, http.MethodOptions, http.MethodPut} {
		w = httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest(method, receivePath, nil))
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "POST" {
			t.Fatalf("%s status=%d allow=%q", method, w.Code, w.Header().Get("Allow"))
		}
	}
}

func TestInboxReceiveAcceptsTheLimitBody(t *testing.T) {
	h := receiveHandler(func(ctx context.Context, input service.ReceiveInput) (service.ReceiveResult, error) {
		if len(input.Body) != InboxBodyLimit {
			t.Fatalf("body length=%d", len(input.Body))
		}
		return accepted(ctx, input)
	}, io.Discard)
	if w := receiveRequest(h, receivePath, "text/plain", strings.Repeat("a", InboxBodyLimit), nil); w.Code != http.StatusAccepted {
		t.Fatalf("status=%d", w.Code)
	}
}

func TestInboxReceiveMapsServiceResults(t *testing.T) {
	fault := func(code string) error { return &model.Fault{Code: code, Message: code + " message"} }
	for _, test := range []struct {
		name       string
		err        error
		status     int
		code       string
		retryAfter string
	}{
		{"invalid", fault("invalid_input"), 400, "invalid_input", ""},
		{"unauthenticated", fault("unauthenticated"), 401, "unauthenticated", ""},
		{"missing", fault("not_found"), 404, "not_found", ""},
		{"conflict", fault("operation_conflict"), 409, "operation_conflict", ""},
		{"gone", fault("inbox_gone"), 410, "inbox_gone", ""},
		{"backlog", fault("rate_limited"), 429, "rate_limited", "60"},
		{"unavailable", fault("service_unavailable"), 503, "service_unavailable", "60"},
		{"unknown commit", &service.WriteError{Operation: "Receive", Outcome: store.TransactionUnknown, Cause: errors.New("lost")}, 503, "write_outcome_unknown", "60"},
		{"failed commit", &service.WriteError{Operation: "Receive", Outcome: store.TransactionNotCommitted, Cause: fault("not_found")}, 500, "internal_error", ""},
		{"unmapped fault", fault("forbidden"), 500, "internal_error", ""},
		{"internal", errors.New("database exploded"), 500, "internal_error", ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			h := receiveHandler(func(context.Context, service.ReceiveInput) (service.ReceiveResult, error) {
				return service.ReceiveResult{}, test.err
			}, io.Discard)
			w := receiveRequest(h, receivePath, "application/json", `{}`, nil)
			if w.Code != test.status || !strings.Contains(w.Body.String(), `"code":"`+test.code+`"`) || w.Header().Get("Retry-After") != test.retryAfter {
				t.Fatalf("status=%d retry=%q body=%s", w.Code, w.Header().Get("Retry-After"), w.Body)
			}
			if strings.Contains(w.Body.String(), "exploded") || strings.Contains(w.Body.String(), "lost") {
				t.Fatalf("internal cause leaked: %s", w.Body)
			}
		})
	}
}

func TestInboxReceiveRateLimitsEachInbox(t *testing.T) {
	calls := 0
	h := receiveHandler(func(ctx context.Context, input service.ReceiveInput) (service.ReceiveResult, error) {
		calls++
		return accepted(ctx, input)
	}, io.Discard)
	for range inboxRatePerMinute {
		if w := receiveRequest(h, receivePath, "application/json", `{}`, nil); w.Code != http.StatusAccepted {
			t.Fatalf("admitted request status=%d", w.Code)
		}
	}
	w := receiveRequest(h, receivePath, "application/json", `{}`, nil)
	if w.Code != http.StatusTooManyRequests || w.Header().Get("Retry-After") != "1" || calls != inboxRatePerMinute {
		t.Fatalf("status=%d retry=%q calls=%d", w.Code, w.Header().Get("Retry-After"), calls)
	}
	other := "/api/v1/assistant-task-inbox/" + testTask
	if w := receiveRequest(h, other, "application/json", `{}`, nil); w.Code != http.StatusAccepted {
		t.Fatalf("other inbox status=%d", w.Code)
	}
}

func TestInboxLimiterRefillsAndSweepsIdleBuckets(t *testing.T) {
	now := time.Date(2026, 11, 19, 0, 0, 0, 0, time.UTC)
	l := newInboxLimiter(func() time.Time { return now })
	for range inboxRatePerMinute {
		if _, ok := l.take("a"); !ok {
			t.Fatal("full bucket refused")
		}
	}
	if wait, ok := l.take("a"); ok || wait != 1 {
		t.Fatalf("empty bucket wait=%d ok=%v", wait, ok)
	}
	now = now.Add(500 * time.Millisecond)
	if _, ok := l.take("a"); !ok {
		t.Fatal("refilled token refused")
	}
	for i := len(l.buckets); i < inboxBucketSweep; i++ {
		l.take(strconv.Itoa(i))
	}
	now = now.Add(time.Minute)
	l.take("b")
	if len(l.buckets) != 1 || l.buckets["b"] == nil {
		t.Fatalf("sweep kept %d buckets", len(l.buckets))
	}
}

func TestInboxReceiveLogsNeverContainTheToken(t *testing.T) {
	results := []error{nil, &model.Fault{Code: "unauthenticated", Message: "A valid inbox token is required."}, errors.New("database failure")}
	for i, result := range results {
		for _, header := range []bool{true, false} {
			t.Run(fmt.Sprintf("%d/%v", i, header), func(t *testing.T) {
				var logs bytes.Buffer
				h := receiveHandler(func(ctx context.Context, input service.ReceiveInput) (service.ReceiveResult, error) {
					if result != nil {
						return service.ReceiveResult{}, result
					}
					return accepted(ctx, input)
				}, &logs)
				target, headers := receivePath+"?token="+receiveToken, map[string]string(nil)
				if header {
					target, headers = receivePath, map[string]string{"Authorization": "Bearer " + receiveToken}
				}
				w := receiveRequest(h, target, "application/json", `{"a":1}`, headers)
				text := logs.String()
				if strings.Contains(text, receiveToken) || strings.Contains(text, "token=") || strings.Contains(text, `{"a":1}`) {
					t.Fatalf("log leaked request secrets: %s", text)
				}
				want := []string{`"inbox_id":"` + testID + `"`, `"status":` + strconv.Itoa(w.Code), `"bytes":7`}
				if result == nil {
					want = append(want, `"classification":"external"`)
				}
				for _, field := range want {
					if !strings.Contains(text, field) {
						t.Fatalf("log missing %s: %s", field, text)
					}
				}
			})
		}
	}
	var logs bytes.Buffer
	h := receiveHandler(accepted, &logs)
	receiveRequest(h, receivePath+"?token="+receiveToken+"&token=x", "application/json", `{}`, nil)
	if strings.Contains(logs.String(), receiveToken) || !strings.Contains(logs.String(), `"status":400`) {
		t.Fatalf("refusal log: %s", logs.String())
	}
}

type failingReader struct{}

func (failingReader) Read([]byte) (int, error) { return 0, errors.New("connection reset") }
