package github

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"syscall"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

const projectWebhookTestID = "59cb4a41-9b96-43cd-8fe3-cbaf394a51e8"

type projectWebhookSecretsFunc func(context.Context, string) (store.GitHubProjectWebhookSecret, error)

func (f projectWebhookSecretsFunc) ReadGitHubProjectWebhookSecret(ctx context.Context, id string) (store.GitHubProjectWebhookSecret, error) {
	return f(ctx, id)
}

type projectWebhookReceiveFunc func(context.Context, string, core.ProjectWebhookIdentity, core.WebhookEvent) (core.ProjectWebhookReceiptResult, error)

func (f projectWebhookReceiveFunc) Receive(ctx context.Context, id string, identity core.ProjectWebhookIdentity, event core.WebhookEvent) (core.ProjectWebhookReceiptResult, error) {
	return f(ctx, id, identity, event)
}

func projectWebhookRequest(event string, body []byte) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/github/projects/"+projectWebhookTestID+"/webhook", bytes.NewReader(body))
	r.Header.Set("X-Hub-Signature-256", webhookSignature(body))
	r.Header.Set("X-GitHub-Event", event)
	r.Header.Set("X-GitHub-Delivery", "b9f1fb19-1d52-44e1-a725-15a4cd3eb015")
	return r.WithContext(requestid.With(r.Context(), "request-123"))
}

func TestProjectWebhookProtocol(t *testing.T) {
	body := []byte(`{ "repository": {"id": 8}, "number": 7, "private": "body-private-value" }`)
	for _, tc := range []struct {
		name, event           string
		body                  []byte
		change                func(*http.Request)
		secretErr, receiveErr error
		result                core.ProjectWebhookReceiptResult
		status, receives      int
	}{
		{"ping", "ping", body, nil, nil, nil, core.ProjectWebhookReceived, 202, 1},
		{"PR", "pull_request", body, nil, nil, nil, core.ProjectWebhookEnqueued, 202, 1},
		{"receipt only", "pull_request", body, nil, nil, nil, core.ProjectWebhookReceived, 202, 1},
		{"wrong repository", "pull_request", body, nil, nil, nil, core.ProjectWebhookRejected, 204, 1},
		{"unrelated", "push", []byte(`not json`), nil, nil, nil, "", 204, 0},
		{"missing event", "", body, nil, nil, nil, "", 400, 0},
		{"duplicate event", "ping", body, func(r *http.Request) { r.Header.Add("X-GitHub-Event", "push") }, nil, nil, "", 400, 0},
		{"missing delivery", "ping", body, func(r *http.Request) { r.Header.Del("X-GitHub-Delivery") }, nil, nil, "", 400, 0},
		{"duplicate delivery", "ping", body, func(r *http.Request) { r.Header.Add("X-GitHub-Delivery", "other") }, nil, nil, "", 400, 0},
		{"unsafe delivery", "ping", body, func(r *http.Request) { r.Header.Set("X-GitHub-Delivery", "private value") }, nil, nil, "", 400, 0},
		{"oversized delivery", "ping", body, func(r *http.Request) { r.Header.Set("X-GitHub-Delivery", strings.Repeat("x", 65)) }, nil, nil, "", 400, 0},
		{"invalid JSON", "ping", []byte(`{`), nil, nil, nil, "", 400, 0},
		{"missing repository", "ping", []byte(`{}`), nil, nil, nil, "", 400, 0},
		{"nonpositive repository", "ping", []byte(`{"repository":{"id":0}}`), nil, nil, nil, "", 400, 0},
		{"missing PR number", "pull_request", []byte(`{"repository":{"id":8}}`), nil, nil, nil, "", 400, 0},
		{"invalid PR number", "pull_request", []byte(`{"repository":{"id":8},"number":-1}`), nil, nil, nil, "", 400, 0},
		{"not configured", "ping", body, nil, model.ErrNotFound, nil, "", 404, 0},
		{"credential read failure", "ping", body, nil, errors.New("private-store-failure"), nil, "", 503, 0},
		{"missing signature", "ping", body, func(r *http.Request) { r.Header.Del("X-Hub-Signature-256") }, nil, nil, "", 401, 0},
		{"duplicate signature", "ping", body, func(r *http.Request) { r.Header.Add("X-Hub-Signature-256", "private-signature") }, nil, nil, "", 401, 0},
		{"invalid signature", "ping", body, func(r *http.Request) { r.Header.Set("X-Hub-Signature-256", webhookSignature([]byte("other"))) }, nil, nil, "", 401, 0},
		{"snapshot changed", "ping", body, nil, nil, core.ErrProjectWebhookSnapshotChanged, "", 503, 1},
		{"unknown commit", "ping", body, nil, nil, errors.New("private-unknown-commit"), "", 503, 1},
		{"unknown result", "ping", body, nil, nil, nil, "unknown", 503, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			reads, receives := 0, 0
			var logs bytes.Buffer
			logger := slog.New(slog.NewTextHandler(&logs, nil))
			secrets := projectWebhookSecretsFunc(func(ctx context.Context, id string) (store.GitHubProjectWebhookSecret, error) {
				reads++
				deadline, ok := ctx.Deadline()
				if id != projectWebhookTestID || !ok || time.Until(deadline) <= 0 || time.Until(deadline) > webhookBudget || requestid.From(ctx) != "request-123" {
					t.Errorf("bad credential read context or id")
				}
				return store.GitHubProjectWebhookSecret{Version: 4, RepositoryID: 8, Secret: []byte("secret")}, tc.secretErr
			})
			receiver := projectWebhookReceiveFunc(func(ctx context.Context, id string, identity core.ProjectWebhookIdentity, event core.WebhookEvent) (core.ProjectWebhookReceiptResult, error) {
				receives++
				if id != projectWebhookTestID || identity != (core.ProjectWebhookIdentity{ProjectID: id, Version: 4, RepositoryID: 8}) || event.Kind != tc.event || event.RepositoryID != 8 || event.DeliveryID != "b9f1fb19-1d52-44e1-a725-15a4cd3eb015" || requestid.From(ctx) != "request-123" {
					t.Errorf("bad receive: %s %+v %+v", id, identity, event)
				}
				if tc.event == "pull_request" && event.Number != 7 {
					t.Errorf("number = %d", event.Number)
				}
				if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > webhookBudget {
					t.Error("missing deadline")
				}
				return tc.result, tc.receiveErr
			})
			mux := http.NewServeMux()
			RegisterProjectWebhookRoute(mux, secrets, receiver, logger)
			r := projectWebhookRequest(tc.event, tc.body)
			if tc.change != nil {
				tc.change(r)
			}
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, r)
			if w.Code != tc.status || reads != 1 || receives != tc.receives {
				t.Fatalf("status=%d reads=%d receives=%d response=%s", w.Code, reads, receives, w.Body.String())
			}
			if w.Header().Get("Cache-Control") != "no-store" {
				t.Error("missing no-store")
			}
			for _, private := range []string{"body-private-value", "private-signature", "private-store-failure", "private-unknown-commit", "sha256=", "secret"} {
				if strings.Contains(logs.String(), private) || strings.Contains(w.Body.String(), private) {
					t.Errorf("private data %q leaked", private)
				}
			}
			if tc.receives == 1 && tc.receiveErr == nil && tc.result != "unknown" && (!strings.Contains(logs.String(), "request-123") || !strings.Contains(logs.String(), "b9f1fb19-1d52-44e1-a725-15a4cd3eb015")) {
				t.Errorf("missing correlation: %s", logs.String())
			}
		})
	}
}

func TestProjectWebhookLimitsAndRoute(t *testing.T) {
	reads, receives := 0, 0
	mux := http.NewServeMux()
	RegisterProjectWebhookRoute(mux, projectWebhookSecretsFunc(func(context.Context, string) (store.GitHubProjectWebhookSecret, error) {
		reads++
		return store.GitHubProjectWebhookSecret{Version: 1, RepositoryID: 8, Secret: []byte("secret")}, nil
	}), projectWebhookReceiveFunc(func(context.Context, string, core.ProjectWebhookIdentity, core.WebhookEvent) (core.ProjectWebhookReceiptResult, error) {
		receives++
		return core.ProjectWebhookReceived, nil
	}), slog.New(slog.NewTextHandler(io.Discard, nil)))
	body := []byte(`{"repository":{"id":8},"padding":"` + strings.Repeat("a", webhookBodyLimit-len(`{"repository":{"id":8},"padding":""}`)) + `"}`)
	for _, tc := range []struct {
		body []byte
		want int
	}{{body, 202}, {append(body, ' '), 413}} {
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, projectWebhookRequest("ping", tc.body))
		if w.Code != tc.want {
			t.Fatalf("size=%d code=%d", len(tc.body), w.Code)
		}
	}
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/github/projects/"+projectWebhookTestID+"/webhook", nil))
	if w.Code != 405 || w.Header().Get("Allow") != "POST" {
		t.Fatalf("method=%d allow=%s", w.Code, w.Header().Get("Allow"))
	}
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/api/v1/github/projects/bad/webhook", strings.NewReader("{}")))
	if w.Code != 404 || reads != 1 || receives != 1 {
		t.Fatalf("invalid project=%d reads=%d receives=%d", w.Code, reads, receives)
	}
}

func TestProjectWebhookCancellation(t *testing.T) {
	for _, phase := range []string{"credential", "receive"} {
		t.Run(phase, func(t *testing.T) {
			started := make(chan struct{})
			mux := http.NewServeMux()
			RegisterProjectWebhookRoute(mux, projectWebhookSecretsFunc(func(ctx context.Context, _ string) (store.GitHubProjectWebhookSecret, error) {
				if phase == "credential" {
					close(started)
					<-ctx.Done()
					return store.GitHubProjectWebhookSecret{}, ctx.Err()
				}
				return store.GitHubProjectWebhookSecret{Version: 1, RepositoryID: 8, Secret: []byte("secret")}, nil
			}), projectWebhookReceiveFunc(func(ctx context.Context, _ string, _ core.ProjectWebhookIdentity, _ core.WebhookEvent) (core.ProjectWebhookReceiptResult, error) {
				if phase != "receive" {
					t.Error("receive after canceled credential read")
					return "", nil
				}
				close(started)
				<-ctx.Done()
				return "", ctx.Err()
			}), slog.New(slog.NewTextHandler(io.Discard, nil)))
			r := projectWebhookRequest("ping", []byte(`{"repository":{"id":8}}`))
			ctx, cancel := context.WithCancel(r.Context())
			w := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { defer close(done); mux.ServeHTTP(w, r.WithContext(ctx)) }()
			select {
			case <-started:
			case <-time.After(time.Second):
				t.Fatal("operation did not start")
			}
			cancel()
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("operation did not stop")
			}
			if w.Body.Len() != 0 {
				t.Fatalf("response written after cancellation: %s", w.Body.String())
			}
		})
	}
}

func TestProjectWebhookBodyDeadline(t *testing.T) {
	r := projectWebhookRequest("ping", []byte(`{"repository":{"id":8}}`))
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Millisecond)
	defer cancel()
	r = r.WithContext(ctx)
	r.Body = &slowWebhookBody{body: strings.NewReader(`{"repository":{"id":8}}`)}
	mux := http.NewServeMux()
	RegisterProjectWebhookRoute(mux, projectWebhookSecretsFunc(func(context.Context, string) (store.GitHubProjectWebhookSecret, error) {
		t.Error("read after deadline")
		return store.GitHubProjectWebhookSecret{}, nil
	}), projectWebhookReceiveFunc(func(context.Context, string, core.ProjectWebhookIdentity, core.WebhookEvent) (core.ProjectWebhookReceiptResult, error) {
		t.Error("receive after deadline")
		return "", nil
	}), slog.New(slog.NewTextHandler(io.Discard, nil)))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Code != 503 {
		t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
	}
}

func TestProjectWebhookOperationDeadline(t *testing.T) {
	for _, phase := range []string{"credential", "receive"} {
		t.Run(phase, func(t *testing.T) {
			h := &projectWebhookHandler{
				budget: 20 * time.Millisecond,
				logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
				secrets: projectWebhookSecretsFunc(func(ctx context.Context, _ string) (store.GitHubProjectWebhookSecret, error) {
					if phase == "credential" {
						<-ctx.Done()
						return store.GitHubProjectWebhookSecret{}, nil
					}
					return store.GitHubProjectWebhookSecret{Version: 1, RepositoryID: 8, Secret: []byte("secret")}, nil
				}),
				receiver: projectWebhookReceiveFunc(func(ctx context.Context, _ string, _ core.ProjectWebhookIdentity, _ core.WebhookEvent) (core.ProjectWebhookReceiptResult, error) {
					if phase != "receive" {
						t.Error("receive after deadline")
						return "", nil
					}
					<-ctx.Done()
					return core.ProjectWebhookReceived, nil
				}),
			}
			r := projectWebhookRequest("ping", []byte(`{"repository":{"id":8}}`))
			r.SetPathValue("projectId", projectWebhookTestID)
			w := httptest.NewRecorder()
			h.receive(w, r)
			if w.Code != 503 {
				t.Fatalf("code=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
}

func TestProjectWebhookBodyCancellation(t *testing.T) {
	r := projectWebhookRequest("ping", []byte(`{"repository":{"id":8}}`))
	ctx, cancel := context.WithCancel(r.Context())
	cancel()
	r = r.WithContext(ctx)
	mux := http.NewServeMux()
	RegisterProjectWebhookRoute(mux, projectWebhookSecretsFunc(func(context.Context, string) (store.GitHubProjectWebhookSecret, error) {
		t.Error("credential read after cancellation")
		return store.GitHubProjectWebhookSecret{}, nil
	}), projectWebhookReceiveFunc(func(context.Context, string, core.ProjectWebhookIdentity, core.WebhookEvent) (core.ProjectWebhookReceiptResult, error) {
		t.Error("receive after cancellation")
		return "", nil
	}), slog.New(slog.NewTextHandler(io.Discard, nil)))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, r)
	if w.Body.Len() != 0 {
		t.Fatalf("response written after cancellation: %s", w.Body.String())
	}
}

func TestProjectWebhookInvalidProjectClosesUnreadBody(t *testing.T) {
	mux := http.NewServeMux()
	RegisterProjectWebhookRoute(mux, projectWebhookSecretsFunc(func(context.Context, string) (store.GitHubProjectWebhookSecret, error) {
		t.Error("credential read for invalid project")
		return store.GitHubProjectWebhookSecret{}, nil
	}), projectWebhookReceiveFunc(func(context.Context, string, core.ProjectWebhookIdentity, core.WebhookEvent) (core.ProjectWebhookReceiptResult, error) {
		t.Error("receipt for invalid project")
		return "", nil
	}), slog.New(slog.NewTextHandler(io.Discard, nil)))
	server := httptest.NewServer(mux)
	defer server.Close()
	for _, tc := range []struct{ name, framing string }{
		{"content length", "Content-Length: 2\r\n\r\n{"},
		{"chunked", "Transfer-Encoding: chunked\r\n\r\n8\r\n{"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn, err := net.DialTimeout("tcp", server.Listener.Addr().String(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
				t.Fatal(err)
			}
			if _, err := fmt.Fprintf(conn, "POST /api/v1/github/projects/invalid/webhook HTTP/1.1\r\nHost: localhost\r\n%s", tc.framing); err != nil {
				t.Fatal(err)
			}
			reader := bufio.NewReader(conn)
			response, err := http.ReadResponse(reader, nil)
			if err != nil {
				t.Fatalf("incomplete request blocked response: %v", err)
			}
			body, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil || response.StatusCode != http.StatusNotFound || !response.Close {
				t.Fatalf("status=%d close=%v body=%q read=%v", response.StatusCode, response.Close, body, err)
			}
			if _, err := reader.ReadByte(); !errors.Is(err, io.EOF) && !errors.Is(err, syscall.ECONNRESET) {
				t.Fatalf("unread-body connection remained open: %v", err)
			}
		})
	}
}
