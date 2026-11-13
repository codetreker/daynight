package github

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
)

type webhookReceiverFunc func(context.Context, core.WebhookEvent) error

func (f webhookReceiverFunc) Receive(ctx context.Context, event core.WebhookEvent) error {
	return f(ctx, event)
}

func webhookSignature(body []byte) string {
	mac := hmac.New(sha256.New, []byte("secret"))
	_, _ = mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
}

func webhookRequest(body []byte, event string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/github/webhook", bytes.NewReader(body))
	r.Header.Set("X-Hub-Signature-256", webhookSignature(body))
	r.Header.Set("X-GitHub-Event", event)
	r.Header.Set("X-GitHub-Delivery", "delivery-1")
	return r
}

func webhookMux(fn webhookReceiverFunc) *http.ServeMux {
	mux := http.NewServeMux()
	RegisterWebhookRoute(mux, fn, "secret", slog.New(slog.NewTextHandler(io.Discard, nil)))
	return mux
}

func TestWebhookProtocol(t *testing.T) {
	valid := []byte("{ \"installation\": {\"id\": 9}, \"repository\": {\"id\": 8}, \"number\": 7, \"ignored\": {\"body\": \"text\"} }")
	tests := []struct {
		name, event string
		body        []byte
		change      func(*http.Request)
		status      int
		want        *core.WebhookEvent
	}{
		{"pull request", "pull_request", valid, nil, 202, &core.WebhookEvent{Kind: "pull_request", DeliveryID: "delivery-1", InstallationID: 9, RepositoryID: 8, Number: 7}},
		{"installation", "installation", []byte(`{"installation":{"id":9}}`), nil, 202, &core.WebhookEvent{Kind: "access", DeliveryID: "delivery-1", InstallationID: 9}},
		{"empty removed", "installation_repositories", []byte(`{"installation":{"id":9},"repositories_removed":[]}`), nil, 202, &core.WebhookEvent{Kind: "access", DeliveryID: "delivery-1", InstallationID: 9}},
		{"repository event", "repository", []byte(`{"installation":{"id":9},"repository":{"id":8}}`), nil, 202, &core.WebhookEvent{Kind: "access", DeliveryID: "delivery-1", InstallationID: 9}},
		{"ping", "ping", []byte(`{"zen":"hi"}`), nil, 204, nil},
		{"unknown event", "new_event", []byte(`{}`), nil, 204, nil},
		{"missing event", "", valid, nil, 400, nil},
		{"missing delivery", "pull_request", valid, func(r *http.Request) { r.Header.Del("X-GitHub-Delivery") }, 400, nil},
		{"missing installation", "pull_request", []byte(`{"repository":{"id":8},"number":7}`), nil, 400, nil},
		{"missing repository", "pull_request", []byte(`{"installation":{"id":9},"number":7}`), nil, 400, nil},
		{"invalid number", "pull_request", []byte(`{"installation":{"id":9},"repository":{"id":8},"number":0}`), nil, 400, nil},
		{"fractional id", "pull_request", []byte(`{"installation":{"id":9.5},"repository":{"id":8},"number":7}`), nil, 400, nil},
		{"malformed JSON", "pull_request", []byte(`{"number":`), nil, 400, nil},
		{"non-object JSON", "ping", []byte(`null`), nil, 400, nil},
		{"wrong signature", "pull_request", valid, func(r *http.Request) { r.Header.Set("X-Hub-Signature-256", webhookSignature([]byte("different"))) }, 401, nil},
		{"missing signature", "pull_request", valid, func(r *http.Request) { r.Header.Del("X-Hub-Signature-256") }, 401, nil},
		{"duplicate signature", "pull_request", valid, func(r *http.Request) { r.Header.Add("X-Hub-Signature-256", webhookSignature(valid)) }, 401, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			mux := webhookMux(func(ctx context.Context, got core.WebhookEvent) error {
				calls++
				if tc.want == nil || got != *tc.want {
					t.Errorf("unexpected event: %+v", got)
				}
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > webhookBudget {
					t.Errorf("invalid deadline: %v", deadline)
				}
				return nil
			})
			r := webhookRequest(tc.body, tc.event)
			if tc.change != nil {
				tc.change(r)
			}
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status = %d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
			if tc.want != nil && calls != 1 || tc.want == nil && calls != 0 {
				t.Fatalf("calls = %d", calls)
			}
		})
	}
}

func TestWebhookBodyLimitAndRawSignature(t *testing.T) {
	body := []byte(`{"padding":"` + strings.Repeat("a", webhookBodyLimit-len(`{"padding":""}`)) + `"}`)
	if len(body) != webhookBodyLimit {
		t.Fatal(len(body))
	}
	calls := 0
	mux := webhookMux(func(context.Context, core.WebhookEvent) error { calls++; return nil })
	for _, tc := range []struct {
		body   []byte
		status int
	}{{body, 204}, {append(body, ' '), 413}} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, webhookRequest(tc.body, "ping"))
		if w.Code != tc.status {
			t.Fatalf("length %d: status %d", len(tc.body), w.Code)
		}
	}
	if calls != 0 {
		t.Fatalf("use case called %d times", calls)
	}
	original := []byte(`{"number":7}`)
	r := webhookRequest(original, "ping")
	r.Body = io.NopCloser(strings.NewReader(`{ "number":7}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 401 {
		t.Fatalf("changed bytes: %d", w.Code)
	}
}

func TestWebhookStorageFailureAndCancellation(t *testing.T) {
	body := []byte(`{"installation":{"id":9},"repository":{"id":8},"number":7}`)
	for _, cause := range []error{errors.New("write failed"), errors.New("commit outcome unknown")} {
		w := httptest.NewRecorder()
		webhookMux(func(context.Context, core.WebhookEvent) error { return cause }).ServeHTTP(w, webhookRequest(body, "pull_request"))
		if w.Code != 503 || strings.Contains(w.Body.String(), cause.Error()) {
			t.Fatalf("failure leaked or wrong status: %d %s", w.Code, w.Body.String())
		}
	}
	started := make(chan struct{})
	done := make(chan struct{})
	r := webhookRequest(body, "pull_request")
	ctx, cancel := context.WithCancel(r.Context())
	r = r.WithContext(ctx)
	go func() {
		defer close(done)
		webhookMux(func(ctx context.Context, _ core.WebhookEvent) error { close(started); <-ctx.Done(); return ctx.Err() }).ServeHTTP(httptest.NewRecorder(), r)
	}()
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("operation not called")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("operation did not observe cancellation")
	}
}

func TestWebhookRouteRejectsOtherMethods(t *testing.T) {
	w := httptest.NewRecorder()
	webhookMux(func(context.Context, core.WebhookEvent) error { t.Fatal("unexpected call"); return nil }).ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/github/webhook", nil))
	if w.Code != 405 || w.Header().Get("Allow") != "POST" {
		t.Fatalf("status %d allow %q", w.Code, w.Header().Get("Allow"))
	}
}

func TestWebhookOperationUsesRemainingBudget(t *testing.T) {
	body := []byte(`{"installation":{"id":9},"repository":{"id":8},"number":7}`)
	r := webhookRequest(body, "pull_request")
	ctx, cancel := context.WithTimeout(r.Context(), 250*time.Millisecond)
	defer cancel()
	r = r.WithContext(ctx)
	r.Body = &slowWebhookBody{body: bytes.NewReader(body)}
	w := httptest.NewRecorder()
	called := false
	webhookMux(func(ctx context.Context, _ core.WebhookEvent) error {
		called = true
		if ctx.Err() != nil {
			t.Fatal("operation context already expired")
		}
		return nil
	}).ServeHTTP(w, r)
	if !called || w.Code != http.StatusAccepted {
		t.Fatalf("called=%t status=%d", called, w.Code)
	}
}

type slowWebhookBody struct {
	body    io.Reader
	delayed bool
}

func (s *slowWebhookBody) Read(p []byte) (int, error) {
	if !s.delayed {
		time.Sleep(100 * time.Millisecond)
		s.delayed = true
	}
	return s.body.Read(p)
}
func (*slowWebhookBody) Close() error { return nil }
