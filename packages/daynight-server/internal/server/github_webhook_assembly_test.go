package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	githubservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

type githubAssemblySignals struct{ received *store.GitHubPRSignal }

func (s *githubAssemblySignals) WriteGitHubSignals(_ context.Context, fn func(store.GitHubSignalWriter) error) (store.Completion, error) {
	err := fn(s)
	return store.Completion{Outcome: store.TransactionCommitted}, err
}
func (s *githubAssemblySignals) SignalPullRequest(_ context.Context, p store.GitHubPRSignal) (int64, error) {
	s.received = &p
	return 1, nil
}
func (s *githubAssemblySignals) SignalAccess(context.Context, store.GitHubAccessSignal) (int64, error) {
	return 0, nil
}

func TestGitHubWebhookProductionRouteAssembly(t *testing.T) {
	cfg := configuredTestConfig()
	cfg.GitHub.WebhookSecret = "assembly-secret"
	db := newHTTPTestStore(t)
	client, err := service.NewIdentityClient(cfg.UniAuth)
	if err != nil {
		t.Fatal(err)
	}
	app := service.NewModules(cfg, db, nil, attachmentTestFiles(t), client)
	app.CredentialUsage = unusedUsageRecorder(testLogger())
	witness := &rootIdentityWitness{IdentityOperations: app.Identity}
	app.Identity = witness
	signals := &githubAssemblySignals{}
	app.GitHubWebhook, err = githubservice.NewWebhookReceiver(signals, 42, testLogger())
	if err != nil {
		t.Fatal(err)
	}
	root, err := New(app, cfg, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		root.BeginShutdown()
		if err := root.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		if err := app.Engine.Stop(ctx); err != nil {
			t.Error(err)
		}
	})
	body := `{"installation":{"id":2},"repository":{"id":3},"number":4}`
	mac := hmac.New(sha256.New, []byte(cfg.GitHub.WebhookSecret))
	_, _ = mac.Write([]byte(body))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/github/webhook", strings.NewReader(body))
	req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	req.Header.Set("X-GitHub-Event", "pull_request")
	req.Header.Set("X-GitHub-Delivery", "assembly")
	res := httptest.NewRecorder()
	root.ServeHTTP(res, req)
	if res.Code != http.StatusAccepted || witness.calls != 0 || signals.received == nil || signals.received.AppID != 42 || signals.received.Number != 4 {
		t.Fatalf("status=%d identity calls=%d signal=%+v", res.Code, witness.calls, signals.received)
	}
}
