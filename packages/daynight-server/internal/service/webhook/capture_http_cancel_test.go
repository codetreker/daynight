package webhook_test

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type captureCancelGate struct {
	*webhook.Capturer
	reached chan struct{}
}

func (g *captureCancelGate) CaptureBatch(ctx context.Context, dao store.WebhookCaptureDAO, facts []protocol.Fact) error {
	return g.Capturer.CaptureBatch(ctx, &captureCancelDAO{WebhookCaptureDAO: dao, reached: g.reached}, facts)
}

type captureCancelDAO struct {
	store.WebhookCaptureDAO
	reached chan struct{}
}

func (g *captureCancelDAO) FreezeAudience(ctx context.Context, project string, types []string) ([]store.WebhookAudience, error) {
	audience, err := g.WebhookCaptureDAO.FreezeAudience(ctx, project, types)
	if err != nil {
		return nil, err
	}
	close(g.reached)
	<-ctx.Done()
	return audience, nil
}

func TestCaptureHTTPContextCancellationAfterFreeze(t *testing.T) {
	f := newCaptureFixture(t, 1)
	token := secret.Random("dnst_")
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(token), f.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	before := captureDatabaseFacts(t, f)
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	f.capture.Logger, f.capture.RequestID = logger, requestid.From
	gate := &captureCancelGate{Capturer: f.capture, reached: make(chan struct{})}
	identity := identityservice.New(f.db, nil, "https://daynight.example/api/v1/auth/callback")
	auth, err := authhttp.NewAuthentication(identity, config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	taskhttp.TaskRoutes(mux, taskservice.NewTasks(f.db, gate), auth, logger)
	handler := httpx.RequestLogging(logger, mux)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+f.project+"/tasks", strings.NewReader(`{"title":"cancelled capture"}`)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://daynight.example")
	req.Header.Set("X-Request-ID", "capture-cancel-request")
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: token})
	done := make(chan struct{})
	go func() { defer close(done); handler.ServeHTTP(httptest.NewRecorder(), req) }()
	select {
	case <-gate.reached:
	case <-done:
		t.Fatalf("request returned before freeze: %s", logs.String())
	case <-time.After(10 * time.Second):
		t.Fatal("freeze was not reached")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled HTTP request did not return")
	}
	if after := captureDatabaseFacts(t, f); after != before {
		t.Fatal("cancelled HTTP request changed source or notifications")
	}
	var found bool
	for _, line := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
		var entry map[string]any
		if err = json.Unmarshal(line, &entry); err != nil {
			t.Fatalf("invalid log: %v", err)
		}
		if entry["msg"] == "webhook capture failed" {
			found = true
			if entry["origin_request_id"] != "capture-cancel-request" || entry["project_id"] != f.project {
				t.Fatalf("failure correlation: %v", entry)
			}
		}
	}
	if !found {
		t.Fatalf("missing capture failure log: %s", logs.String())
	}
}

func TestCaptureHTTPSuccessRequestEventLogCorrelation(t *testing.T) {
	f := newCaptureFixture(t, 1)
	token := secret.Random("dnst_")
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(token), f.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	f.capture.Logger, f.capture.RequestID = logger, requestid.From
	identity := identityservice.New(f.db, nil, "https://daynight.example/api/v1/auth/callback")
	auth, err := authhttp.NewAuthentication(identity, config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	taskhttp.TaskRoutes(mux, taskservice.NewTasks(f.db, f.capture), auth, logger)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/projects/"+f.project+"/tasks", strings.NewReader(`{"title":"http event secret title"}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Origin", "https://daynight.example")
	req.Header.Set("X-Request-ID", "http-event-request")
	req.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: token})
	w := httptest.NewRecorder()
	httpx.RequestLogging(logger, mux).ServeHTTP(w, req)
	if w.Code != http.StatusCreated {
		t.Fatalf("HTTP status=%d body=%s", w.Code, w.Body.String())
	}
	var result struct {
		ID string `json:"id"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	var event, origin, delivery, endpoint string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT e.id::text,e.origin_request_id,d.id::text,d.endpoint_id::text FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1`, result.ID).Scan(&event, &origin, &delivery, &endpoint); err != nil {
		t.Fatal(err)
	}
	if origin != "http-event-request" {
		t.Fatalf("saved origin request ID %q", origin)
	}
	var found bool
	for _, line := range bytes.Split(bytes.TrimSpace(logs.Bytes()), []byte("\n")) {
		var entry map[string]any
		if err = json.Unmarshal(line, &entry); err != nil {
			t.Fatal(err)
		}
		if entry["event_id"] == event {
			found = true
			if entry["origin_request_id"] != origin || entry["delivery_id"] != delivery || entry["endpoint_id"] != endpoint || entry["project_id"] != f.project {
				t.Fatalf("event correlation: %v", entry)
			}
		}
	}
	if !found {
		t.Fatalf("event ID not found in logs: %s", logs.String())
	}
	for _, private := range []string{"http event secret title", "receiver.example", "/hook", "specversion"} {
		if strings.Contains(logs.String(), private) {
			t.Fatalf("sensitive value %q in logs", private)
		}
	}
}
