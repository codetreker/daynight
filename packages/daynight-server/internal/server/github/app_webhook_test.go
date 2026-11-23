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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

const appWebhookID = "59cb4a41-9b96-43cd-8fe3-cbaf394a51e8"

type appWebhookStub struct {
	auth    func(context.Context, string, []byte, string) (service.AppWebhookIdentity, error)
	receive func(context.Context, service.AppWebhookIdentity, core.WebhookEvent) error
}

func (s appWebhookStub) AuthenticateAppWebhook(ctx context.Context, id string, body []byte, signature string) (service.AppWebhookIdentity, error) {
	return s.auth(ctx, id, body, signature)
}
func (s appWebhookStub) ReceiveAppWebhook(ctx context.Context, identity service.AppWebhookIdentity, event core.WebhookEvent) error {
	return s.receive(ctx, identity, event)
}
func appWebhookMux(s appWebhookStub) *http.ServeMux {
	mux := http.NewServeMux()
	RegisterAppWebhookRoute(mux, s, slog.New(slog.NewTextHandler(io.Discard, nil)))
	return mux
}
func appWebhookRequest(id, event string, body []byte) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/github/apps/"+id+"/webhook", bytes.NewReader(body))
	r.Header.Set("X-Hub-Signature-256", "signature")
	r.Header.Set("X-GitHub-Event", event)
	r.Header.Set("X-GitHub-Delivery", "delivery")
	return r
}

func TestAppWebhookProtocolAndIdentity(t *testing.T) {
	body := []byte(`{ "installation":{"id":9},"repository":{"id":8},"number":7 }`)
	identity := service.AppWebhookIdentity{AppID: appWebhookID, CredentialVersion: 4}
	tests := []struct {
		name, event         string
		payload             []byte
		change              func(*http.Request)
		authErr, receiveErr error
		status, receives    int
	}{
		{"PR", "pull_request", body, nil, nil, nil, 202, 1},
		{"access", "installation", []byte(`{"installation":{"id":9}}`), nil, nil, nil, 202, 1},
		{"unrelated", "ping", []byte(`{}`), nil, nil, nil, 204, 0},
		{"unrelated malformed", "new_event", []byte(`{`), nil, nil, nil, 204, 0},
		{"missing event", "", body, nil, nil, nil, 400, 0},
		{"duplicate event", "ping", body, func(r *http.Request) { r.Header.Add("X-GitHub-Event", "other") }, nil, nil, 400, 0},
		{"invalid body", "pull_request", []byte(`{`), nil, nil, nil, 400, 0},
		{"missing delivery", "pull_request", body, func(r *http.Request) { r.Header.Del("X-GitHub-Delivery") }, nil, nil, 400, 0},
		{"unknown App", "pull_request", body, nil, model.ErrNotFound, nil, 404, 0},
		{"invalid signature", "pull_request", body, nil, service.ErrAppWebhookUnauthenticated, nil, 401, 0},
		{"read failure", "pull_request", body, nil, errors.New("private cause"), nil, 503, 0},
		{"unconfirmed write", "pull_request", body, nil, nil, errors.New("unknown commit"), 503, 1},
		{"duplicate signature", "pull_request", body, func(r *http.Request) { r.Header.Add("X-Hub-Signature-256", "another") }, service.ErrAppWebhookUnauthenticated, nil, 401, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			auths, receives := 0, 0
			ops := appWebhookStub{
				auth: func(ctx context.Context, id string, got []byte, signature string) (service.AppWebhookIdentity, error) {
					auths++
					if id != appWebhookID || !bytes.Equal(got, tc.payload) {
						t.Errorf("authentication input changed: %q %q", id, got)
					}
					if tc.name == "duplicate signature" && signature != "" {
						t.Errorf("multiple signature values accepted: %q", signature)
					}
					deadline, ok := ctx.Deadline()
					if !ok || time.Until(deadline) <= 0 || time.Until(deadline) > webhookBudget {
						t.Errorf("invalid deadline: %v", deadline)
					}
					return identity, tc.authErr
				},
				receive: func(_ context.Context, got service.AppWebhookIdentity, event core.WebhookEvent) error {
					receives++
					if got != identity || event.DeliveryID != "delivery" || event.InstallationID != 9 {
						t.Errorf("unexpected identity or event: %+v %+v", got, event)
					}
					if tc.event == "pull_request" && (event.Kind != "pull_request" || event.RepositoryID != 8 || event.Number != 7) {
						t.Errorf("unexpected PR event: %+v", event)
					}
					return tc.receiveErr
				},
			}
			r := appWebhookRequest(appWebhookID, tc.event, tc.payload)
			if tc.change != nil {
				tc.change(r)
			}
			// These untrusted headers cannot choose or change the App identity.
			r.Header.Set("X-GitHub-App-ID", "999")
			w := httptest.NewRecorder()
			appWebhookMux(ops).ServeHTTP(w, r)
			if w.Code != tc.status || auths != 1 || receives != tc.receives {
				t.Fatalf("status=%d auth=%d receive=%d body=%s", w.Code, auths, receives, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "private cause") || strings.Contains(w.Body.String(), "unknown commit") {
				t.Fatal("private error leaked")
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Fatal("missing no-store")
			}
		})
	}
}

func TestAppWebhookBodyLimitAndRoute(t *testing.T) {
	calls := 0
	op := appWebhookStub{
		auth: func(_ context.Context, _ string, body []byte, _ string) (service.AppWebhookIdentity, error) {
			calls++
			return service.AppWebhookIdentity{}, nil
		},
		receive: func(context.Context, service.AppWebhookIdentity, core.WebhookEvent) error {
			t.Fatal("unexpected receive")
			return nil
		},
	}
	mux := appWebhookMux(op)
	body := []byte(`{"padding":"` + strings.Repeat("a", webhookBodyLimit-len(`{"padding":""}`)) + `"}`)
	for _, tc := range []struct {
		body []byte
		want int
	}{{body, 204}, {append(body, ' '), 413}} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, appWebhookRequest(appWebhookID, "ping", tc.body))
		if w.Code != tc.want {
			t.Fatalf("length=%d status=%d", len(tc.body), w.Code)
		}
	}
	if calls != 1 {
		t.Fatalf("auth calls=%d", calls)
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/github/apps/"+appWebhookID+"/webhook", nil))
	if w.Code != 405 || w.Header().Get("Allow") != "POST" {
		t.Fatalf("status=%d allow=%q", w.Code, w.Header().Get("Allow"))
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, appWebhookRequest("not-a-uuid", "ping", []byte(`{}`)))
	if w.Code != 404 || calls != 1 {
		t.Fatalf("invalid identity status=%d calls=%d", w.Code, calls)
	}
}

func TestAppWebhookContextAfterBodyRead(t *testing.T) {
	body := []byte(`{"installation":{"id":9}}`)
	r := appWebhookRequest(appWebhookID, "installation", body)
	ctx, cancel := context.WithTimeout(r.Context(), 250*time.Millisecond)
	defer cancel()
	r = r.WithContext(ctx)
	r.Body = &slowWebhookBody{body: bytes.NewReader(body)}
	called := false
	ops := appWebhookStub{
		auth: func(ctx context.Context, _ string, _ []byte, _ string) (service.AppWebhookIdentity, error) {
			deadline, ok := ctx.Deadline()
			if !ok || time.Until(deadline) > 200*time.Millisecond {
				t.Errorf("body read did not consume budget: %v", deadline)
			}
			return service.AppWebhookIdentity{}, nil
		},
		receive: func(ctx context.Context, _ service.AppWebhookIdentity, _ core.WebhookEvent) error {
			called = true
			return ctx.Err()
		},
	}
	w := httptest.NewRecorder()
	appWebhookMux(ops).ServeHTTP(w, r)
	if !called || w.Code != 202 {
		t.Fatalf("called=%v status=%d", called, w.Code)
	}
}

// appWebhookIntegrationStore keeps only the store boundary controlled; the
// actual service authenticates and records the minimal event through core.
type appWebhookIntegrationStore struct{ writes int }

func (*appWebhookIntegrationStore) ReadGitHubAppWebhook(context.Context, string) (store.GitHubAppWebhookSnapshot, error) {
	return store.GitHubAppWebhookSnapshot{CredentialVersion: 3, Secret: []byte("secret")}, nil
}
func (s *appWebhookIntegrationStore) WriteGitHubAppSignals(ctx context.Context, id string, version int64, f func(store.GitHubAppSignalWriter) error) (store.Completion, error) {
	if id != appWebhookID || version != 3 {
		return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("identity mismatch")
	}
	s.writes++
	return store.Completion{Outcome: store.TransactionCommitted}, f(s)
}
func (*appWebhookIntegrationStore) SignalPullRequest(context.Context, store.GitHubAppPRSignal) (int64, error) {
	return 0, nil
}
func (*appWebhookIntegrationStore) SignalAccess(context.Context, store.GitHubAppAccessSignal) (int64, error) {
	return 0, nil
}

func TestAppWebhookRealSignature(t *testing.T) {
	s := &appWebhookIntegrationStore{}
	receiver, err := service.NewAppWebhookReceiver(s, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterAppWebhookRoute(mux, receiver, slog.New(slog.NewTextHandler(io.Discard, nil)))
	body := []byte(`{"installation":{"id":9}}`)
	for _, tc := range []struct {
		signed []byte
		want   int
	}{{body, 202}, {[]byte("other"), 401}} {
		r := appWebhookRequest(appWebhookID, "installation", body)
		r.Header.Set("X-Hub-Signature-256", webhookSignature(tc.signed))
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != tc.want {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	}
	if s.writes != 1 {
		t.Fatalf("writes=%d", s.writes)
	}
}

func TestAppWebhookBodyDeadlineReturnsUnavailable(t *testing.T) {
	r := appWebhookRequest(appWebhookID, "ping", []byte(`{}`))
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Millisecond)
	defer cancel()
	r = r.WithContext(ctx)
	r.Body = &slowWebhookBody{body: strings.NewReader(`{}`)}
	ops := appWebhookStub{
		auth: func(context.Context, string, []byte, string) (service.AppWebhookIdentity, error) {
			t.Fatal("authentication after deadline")
			return service.AppWebhookIdentity{}, nil
		},
		receive: func(context.Context, service.AppWebhookIdentity, core.WebhookEvent) error {
			t.Fatal("receive after deadline")
			return nil
		},
	}
	w := httptest.NewRecorder()
	appWebhookMux(ops).ServeHTTP(w, r)
	if w.Code != 503 {
		t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
	}
}

func TestAppWebhookParseDeadlineOverridesResult(t *testing.T) {
	for _, result := range []struct {
		name            string
		relevant, valid bool
	}{{"invalid", false, false}, {"unrelated", false, true}, {"relevant", true, true}} {
		t.Run(result.name, func(t *testing.T) {
			ops := appWebhookStub{
				auth: func(context.Context, string, []byte, string) (service.AppWebhookIdentity, error) {
					return service.AppWebhookIdentity{}, nil
				},
				receive: func(context.Context, service.AppWebhookIdentity, core.WebhookEvent) error {
					t.Fatal("receive after deadline")
					return nil
				},
			}
			h := &appWebhookHandler{operations: ops, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), budget: 20 * time.Millisecond,
				parse: func(ctx context.Context, _ string, _ string, _ []byte) (core.WebhookEvent, bool, bool) {
					<-ctx.Done()
					return core.WebhookEvent{}, result.relevant, result.valid
				},
			}
			r := appWebhookRequest(appWebhookID, "ping", []byte(`{}`))
			r.SetPathValue("localAppId", appWebhookID)
			w := httptest.NewRecorder()
			h.receive(w, r)
			if w.Code != http.StatusServiceUnavailable {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestAppWebhookAuthenticationDeadlineOverridesRefusal(t *testing.T) {
	for _, authErr := range []error{model.ErrNotFound, service.ErrAppWebhookUnauthenticated, nil} {
		ops := appWebhookStub{
			auth: func(ctx context.Context, _ string, _ []byte, _ string) (service.AppWebhookIdentity, error) {
				<-ctx.Done()
				return service.AppWebhookIdentity{}, authErr
			},
			receive: func(context.Context, service.AppWebhookIdentity, core.WebhookEvent) error {
				t.Fatal("receive after deadline")
				return nil
			},
		}
		h := &appWebhookHandler{operations: ops, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), budget: 20 * time.Millisecond, parse: appWebhookEvent}
		r := appWebhookRequest(appWebhookID, "ping", []byte(`{}`))
		r.SetPathValue("localAppId", appWebhookID)
		w := httptest.NewRecorder()
		h.receive(w, r)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("auth error %v: status=%d body=%s", authErr, w.Code, w.Body.String())
		}
	}
}

func webhookSignature(body []byte) string {
	mac := hmac.New(sha256.New, []byte("secret"))
	_, _ = mac.Write(body)
	return "sha256=" + hex.EncodeToString(mac.Sum(nil))
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
