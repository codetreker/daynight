package postgres

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	coregithub "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	servergithub "github.com/codetreker/daynight/packages/daynight-server/internal/server/github"
	servicegithub "github.com/codetreker/daynight/packages/daynight-server/internal/service/github"
	"github.com/jackc/pgx/v5/pgxpool"
)

func githubDelivery(t *testing.T, handler http.Handler, event, delivery, body string) int {
	t.Helper()
	mac := hmac.New(sha256.New, []byte("secret"))
	_, _ = mac.Write([]byte(body))
	req := httptest.NewRequest(http.MethodPost, "/api/v1/github/webhook", bytes.NewBufferString(body))
	req.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	req.Header.Set("X-GitHub-Event", event)
	req.Header.Set("X-GitHub-Delivery", delivery)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response.Code
}

func githubWebhookHandler(t *testing.T, db *Store) http.Handler {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	receiver, err := servicegithub.NewWebhookReceiver(db, 10, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	servergithub.RegisterWebhookRoute(mux, receiver, "secret", logger)
	return mux
}

func TestGitHubWebhookReceptionAndRecoveryWithStore(t *testing.T) {
	db := isolatedStore(t)
	a, b, disconnected := queryProject(t, db, 1), queryProject(t, db, 2), queryProject(t, db, 3)
	for _, id := range []string{a.ID, b.ID, disconnected.ID} {
		b2Configure(t, db, id, 10, 20, 30)
		mustQueryExec(t, db, `UPDATE project_github SET repository_full_name='owner/repo', next_poll_at=clock_timestamp()+interval '1 hour', next_access_check_at=clock_timestamp()+interval '1 hour' WHERE project_id=$1`, id)
	}
	mustQueryExec(t, db, `UPDATE project_github SET enabled=false, sync_enabled=false WHERE project_id=$1`, disconnected.ID)
	body := `{"installation":{"id":20},"repository":{"id":30},"number":7,"action":"closed"}`
	h := githubWebhookHandler(t, db)
	for _, delivery := range []string{"new", "new", "older"} {
		if code := githubDelivery(t, h, "pull_request", delivery, body); code != http.StatusAccepted {
			t.Fatalf("delivery: %d", code)
		}
	}
	var count int
	if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_github_pending_prs WHERE number=7`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("fanout pending: %d %v", count, err)
	}
	// Reconstruct the receiver and executor after reception; persisted work remains due.
	h = githubWebhookHandler(t, db)
	due, err := db.DueGitHubProjects(t.Context(), 10, time.Now().Add(time.Second), 32)
	if err != nil || len(due) != 2 {
		t.Fatalf("due after restart: %v %v", due, err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	fact := executorFact(7, "open", "current", "current body", now)
	remote := &controlledGitHub{pulls: map[int64]githubpr.Observation{7: fact}, page: []githubpr.Observation{fact}}
	var logs bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	executor, err := servicegithub.NewExecutor(db, remote, 10, logger)
	if err != nil {
		t.Fatal(err)
	}
	if err = executor.Execute(t.Context(), a.ID); err != nil {
		t.Fatalf("hint: %v", err)
	}
	assertHintCheckpoint(t, logs.String(), "older")
	var head string
	if err = db.Pool.QueryRow(t.Context(), `SELECT head_sha FROM project_pull_requests WHERE project_id=$1 AND number=7`, a.ID).Scan(&head); err != nil || head != "current" {
		t.Fatalf("current fact: %s %v", head, err)
	}
	// No delivery for the next update: a due poll still reconciles current facts.
	fact.HeadSHA = "poll-repair"
	remote.page = []githubpr.Observation{fact}
	remote.pulls[8] = executorFact(8, "open", "hint", "hint body", now)
	pollHint := `{"installation":{"id":20},"repository":{"id":30},"number":8}`
	if code := githubDelivery(t, h, "pull_request", "during-poll", pollHint); code != http.StatusAccepted {
		t.Fatalf("poll hint: %d", code)
	}
	logs.Reset()
	mustQueryExec(t, db, `UPDATE project_github SET next_poll_at=clock_timestamp()-interval '1 second' WHERE project_id=$1`, a.ID)
	if err = executor.Execute(t.Context(), a.ID); err != nil {
		t.Fatalf("poll: %v", err)
	}
	assertHintCheckpoint(t, logs.String(), "during-poll")
	if err = db.Pool.QueryRow(t.Context(), `SELECT head_sha FROM project_pull_requests WHERE project_id=$1 AND number=7`, a.ID).Scan(&head); err != nil || head != "poll-repair" {
		t.Fatalf("poll repair: %s %v", head, err)
	}
	access := `{"installation":{"id":20},"repositories_removed":[]}`
	if code := githubDelivery(t, h, "installation_repositories", "access", access); code != http.StatusAccepted {
		t.Fatalf("access delivery: %d", code)
	}
	if err = db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_github WHERE access_hint_id IS NOT NULL AND last_webhook_received_at IS NOT NULL`).Scan(&count); err != nil || count != 2 {
		t.Fatalf("access fanout: %d %v", count, err)
	}
	var enabled bool
	if err = db.Pool.QueryRow(t.Context(), `SELECT enabled FROM project_github WHERE project_id=$1`, disconnected.ID).Scan(&enabled); err != nil || enabled {
		t.Fatalf("disconnect: %t %v", enabled, err)
	}
}

func assertHintCheckpoint(t *testing.T, logs, delivery string) {
	t.Helper()
	for _, line := range strings.Split(logs, "\n") {
		if strings.Contains(line, `"msg":"github request checkpoint"`) && strings.Contains(line, `"delivery_id":"`+delivery+`"`) && strings.Contains(line, `"hint_id":`) {
			return
		}
	}
	t.Fatalf("checkpoint missing hint context for %s: %s", delivery, logs)
}

func TestGitHubWebhookUnknownCommitIsNotAcknowledged(t *testing.T) {
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	b2Configure(t, db, project.ID, 10, 20, 30)
	var armed, lost atomic.Bool
	config := db.Pool.Config().Copy()
	config.ConnConfig.TLSConfig, config.ConnConfig.Fallbacks = nil, nil
	config.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		conn, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		return &lostGrantCommitConn{Conn: conn, armed: &armed, lost: &lost}, nil
	}
	pool, err := pgxpool.NewWithConfig(t.Context(), config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	h := githubWebhookHandler(t, &Store{Pool: pool})
	armed.Store(true)
	code := githubDelivery(t, h, "pull_request", "unknown", `{"installation":{"id":20},"repository":{"id":30},"number":7}`)
	if !lost.Load() || code != http.StatusServiceUnavailable {
		t.Fatalf("lost=%t response=%d", lost.Load(), code)
	}
	var count int
	if err := db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1 AND number=7`, project.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("actual committed hint: %d %v", count, err)
	}
}

func TestGitHubSignalDeadlineReleasesBlockedConnection(t *testing.T) {
	db := isolatedStore(t)
	project := queryProject(t, db, 1)
	b2Configure(t, db, project.ID, 10, 20, 30)
	lock, err := db.Pool.Begin(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(context.Background())
	if _, err = lock.Exec(t.Context(), `SELECT project_id FROM project_github WHERE project_id=$1 FOR UPDATE`, project.ID); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.NewWithConfig(t.Context(), db.Pool.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	done := make(chan error, 1)
	receiver, err := servicegithub.NewWebhookReceiver(&Store{Pool: pool}, 10, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		done <- receiver.Receive(ctx, coregithub.WebhookEvent{Kind: "pull_request", DeliveryID: "blocked", InstallationID: 20, RepositoryID: 30, Number: 7})
	}()
	waitForQueryLock(t, db, "WITH locked AS MATERIALIZED")
	select {
	case err = <-done:
		if err == nil {
			t.Fatal("blocked signal unexpectedly succeeded")
		}
	case <-time.After(4 * time.Second):
		t.Fatal("signal exceeded deadline")
	}
	// pgxpool releases a closed connection after its transport cleanup finishes.
	until := time.Now().Add(2 * time.Second)
	for pool.Stat().AcquiredConns() != 0 && time.Now().Before(until) {
		time.Sleep(10 * time.Millisecond)
	}
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("connection still acquired: %+v", pool.Stat())
	}
	if err = lock.Rollback(t.Context()); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = db.Pool.QueryRow(t.Context(), `SELECT count(*) FROM project_github_pending_prs WHERE project_id=$1`, project.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("pending=%d err=%v", count, err)
	}
}
