package task

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

const searchTestID = "11111111-1111-4111-8111-111111111111"

type failedSearchReader struct{ err error }

func (f failedSearchReader) ReadTaskSearch(context.Context, func(store.TaskSearchSnapshot) error) error {
	return f.err
}
func serveSearch(reader store.TaskSearchReader, logs *bytes.Buffer) *httptest.Server {
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	h := searchHandler{reader: reader, logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/projects/{projectId}/tasks/search", func(w http.ResponseWriter, r *http.Request) {
		h.search(w, r, model.Principal{Kind: model.PATCredential, UserID: searchTestID, CredentialID: searchTestID})
	})
	return httptest.NewServer(httpx.RequestLogging(logger, mux))
}
func postSearch(t *testing.T, server *httptest.Server, body string) (int, string) {
	t.Helper()
	resp, err := http.Post(server.URL+"/api/v1/projects/"+searchTestID+"/tasks/search", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("cache header missing")
	}
	return resp.StatusCode, string(data)
}
func TestSearchHTTPExpressionErrorAndPrivacy(t *testing.T) {
	var logs bytes.Buffer
	server := serveSearch(failedSearchReader{errors.New("must not execute")}, &logs)
	defer server.Close()
	status, body := postSearch(t, server, `{"query":"私人文本 AND (A"}`)
	if status != 400 {
		t.Fatalf("status=%d body=%s", status, body)
	}
	var result struct {
		Error struct {
			Code    string `json:"code"`
			Details struct {
				Reason   string `json:"reason"`
				Position int    `json:"position"`
				Length   int    `json:"length"`
			} `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &result); err != nil {
		t.Fatal(err)
	}
	if result.Error.Code != "invalid_search_expression" || result.Error.Details.Reason != "unclosed_group" {
		t.Fatalf("%s", body)
	}
	if strings.Contains(logs.String(), "私人文本") {
		t.Fatal("query in log")
	}
	status, body = postSearch(t, server, `{"query":"ok","cursor":null,"unknown":1}`)
	if status != 400 {
		t.Fatalf("status=%d body=%s", status, body)
	}
}
func TestSearchHTTPDeadlineAndFailurePrivacy(t *testing.T) {
	var logs bytes.Buffer
	server2 := serveSearch(failedSearchReader{&store.Error{Phase: "SQL secret", Cause: errors.New("driver secret")}}, &logs)
	defer server2.Close()
	status, body := postSearch(t, server2, `{"query":"private query"}`)
	if status != 500 {
		t.Fatalf("status=%d body=%s", status, body)
	}
	for _, secret := range []string{"private query", "SQL secret", "driver secret"} {
		if strings.Contains(logs.String(), secret) {
			t.Fatalf("log leaked %q", secret)
		}
	}
}

type blockingPostgresReader struct {
	pool     *pgxpool.Pool
	pid      atomic.Int32
	started  chan struct{}
	finished chan struct{}
}

func (r *blockingPostgresReader) ReadTaskSearch(ctx context.Context, _ func(store.TaskSearchSnapshot) error) error {
	if r.finished != nil {
		defer close(r.finished)
	}
	return store.ReadOnlySnapshot(ctx, r.pool, func(tx pgx.Tx) error {
		var pid int32
		if err := tx.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&pid); err != nil {
			return err
		}
		r.pid.Store(pid)
		if r.started != nil {
			close(r.started)
		}
		_, err := tx.Exec(ctx, "SELECT pg_sleep(30)")
		return err
	})
}

func TestSearchHTTPCallerCancellationReleasesPostgres(t *testing.T) {
	t.Parallel()
	url := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	reader := &blockingPostgresReader{pool: pool, started: make(chan struct{}), finished: make(chan struct{})}
	var logs bytes.Buffer
	server := serveSearch(reader, &logs)
	defer server.Close()
	requestContext, cancelRequest := context.WithCancel(ctx)
	defer cancelRequest()
	request, err := http.NewRequestWithContext(requestContext, "POST", server.URL+"/api/v1/projects/"+searchTestID+"/tasks/search", strings.NewReader(`{"query":"cache"}`))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	done := make(chan error, 1)
	go func() {
		response, err := http.DefaultClient.Do(request)
		if response != nil {
			response.Body.Close()
		}
		done <- err
	}()
	select {
	case <-reader.started:
	case <-ctx.Done():
		t.Fatal("database query did not start")
	}
	for {
		var running bool
		if err := pool.QueryRow(ctx, "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND state='active' AND query LIKE '%pg_sleep(30)%')", reader.pid.Load()).Scan(&running); err != nil {
			t.Fatal(err)
		}
		if running {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("database sleep did not start")
		case <-time.After(10 * time.Millisecond):
		}
	}
	cancelRequest()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("expected caller cancellation: %v", err)
	}
	select {
	case <-reader.finished:
	case <-ctx.Done():
		t.Fatal("database cleanup did not finish")
	}
	var active int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE pid=$1 AND state='active'", reader.pid.Load()).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 0 {
		t.Fatal("canceled database query remains active")
	}
}

func TestSearchHTTPPostgresDeadlineCancelsQuery(t *testing.T) {
	t.Parallel()
	url := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	reader := &blockingPostgresReader{pool: pool}
	var logs bytes.Buffer
	server := serveSearch(reader, &logs)
	defer server.Close()
	status, body := postSearch(t, server, `{"query":"private query"}`)
	if status != 504 || !strings.Contains(body, `"search_timeout"`) {
		t.Fatalf("status=%d body=%s logs=%s", status, body, logs.String())
	}
	pid := reader.pid.Load()
	if pid == 0 {
		t.Fatal("database query did not start")
	}
	var active int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM pg_stat_activity WHERE pid=$1 AND state='active'", pid).Scan(&active); err != nil {
		t.Fatal(err)
	}
	if active != 0 {
		t.Fatal("canceled database query remains active")
	}
	if strings.Contains(logs.String(), "private query") || strings.Contains(logs.String(), "pg_sleep") {
		t.Fatal("query or SQL leaked into logs")
	}
}

func TestSearchHTTPTransactionFailureIsNotTimeout(t *testing.T) {
	var logs bytes.Buffer
	server := serveSearch(failedSearchReader{&store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: context.DeadlineExceeded}}, &logs)
	defer server.Close()
	status, body := postSearch(t, server, `{"query":"cache"}`)
	if status != 500 || !strings.Contains(body, `"internal_error"`) || !strings.Contains(logs.String(), `"cause":"database"`) {
		t.Fatalf("status=%d body=%s logs=%s", status, body, logs.String())
	}
}

type failedCompletionReader struct{ cleanup bool }

func (r failedCompletionReader) ReadTaskSearch(ctx context.Context, _ func(store.TaskSearchSnapshot) error) error {
	<-ctx.Done()
	if r.cleanup {
		return &store.TransactionError{Phase: "cleanup", CleanupFailed: true, Outcome: store.TransactionUnknown, Cause: errors.Join(ctx.Err(), errors.New("cleanup failed"))}
	}
	return &store.TransactionError{Phase: "commit", CommitAttempted: true, Outcome: store.TransactionUnknown, Cause: errors.Join(ctx.Err(), errors.New("commit failed"))}
}

func TestSearchHTTPDeadlineDoesNotHideCompletionFailures(t *testing.T) {
	for _, test := range []struct {
		name    string
		cleanup bool
	}{{"commit", false}, {"cleanup", true}} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var logs bytes.Buffer
			server := serveSearch(failedCompletionReader{cleanup: test.cleanup}, &logs)
			defer server.Close()
			status, body := postSearch(t, server, `{"query":"cache"}`)
			if status != 500 || !strings.Contains(body, `"internal_error"`) || !strings.Contains(logs.String(), `"cause":"database"`) {
				t.Fatalf("status=%d body=%s logs=%s", status, body, logs.String())
			}
		})
	}
}
