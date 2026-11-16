package server

import (
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

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	githubservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
)

type githubAssemblySignals struct {
	received *store.GitHubAppPRSignal
	appID    string
}

func (s *githubAssemblySignals) ReadGitHubAppWebhook(_ context.Context, id string) (store.GitHubAppWebhookSnapshot, error) {
	s.appID = id
	return store.GitHubAppWebhookSnapshot{GitHubAppID: 42, CredentialVersion: 3, Secret: []byte("assembly-secret")}, nil
}
func (s *githubAssemblySignals) WriteGitHubAppSignals(_ context.Context, id string, version int64, fn func(store.GitHubAppSignalWriter) error) (store.Completion, error) {
	if id != s.appID || version != 3 {
		return store.Completion{Outcome: store.TransactionNotCommitted}, errors.New("unexpected identity")
	}
	err := fn(s)
	return store.Completion{Outcome: store.TransactionCommitted}, err
}
func (s *githubAssemblySignals) SignalPullRequest(_ context.Context, p store.GitHubAppPRSignal) (int64, error) {
	s.received = &p
	return 1, nil
}
func (s *githubAssemblySignals) SignalAccess(context.Context, store.GitHubAppAccessSignal) (int64, error) {
	return 0, nil
}

func TestGitHubWebhookProductionRouteAssembly(t *testing.T) {
	cfg := configuredTestConfig()
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
	app.GitHubWebhook, err = githubservice.NewAppWebhookReceiver(signals, testLogger())
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
	mac := hmac.New(sha256.New, []byte("assembly-secret"))
	_, _ = mac.Write([]byte(body))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/github/apps/58484824-12a6-42f3-914a-052a6673403b/webhook", strings.NewReader(body))
	req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	req.Header.Set("X-GitHub-Event", "pull_request")
	req.Header.Set("X-GitHub-Delivery", "assembly")
	res := httptest.NewRecorder()
	root.ServeHTTP(res, req)
	if res.Code != http.StatusAccepted || witness.calls != 0 || signals.received == nil || signals.appID != "58484824-12a6-42f3-914a-052a6673403b" || signals.received.Number != 4 {
		t.Fatalf("status=%d identity calls=%d signal=%+v", res.Code, witness.calls, signals.received)
	}
	for _, path := range []string{
		"/api/v1/github/webhook",
	} {
		res = httptest.NewRecorder()
		root.ServeHTTP(res, httptest.NewRequest(http.MethodPost, path, nil))
		if res.Code != http.StatusNotFound {
			t.Fatalf("retired route %s returned %d", path, res.Code)
		}
	}
}
