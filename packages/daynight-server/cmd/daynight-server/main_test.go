//go:build startupshutdown

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testEnvironment(t *testing.T) map[string]string {
	t.Helper()
	url := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	address := testAddress(t)
	origin := "http://" + address
	return map[string]string{
		"DAYNIGHT_DATABASE_URL": url, "DAYNIGHT_STORAGE_ROOT": testStorageRoot(t), "DAYNIGHT_LISTEN_ADDR": address,
		"DAYNIGHT_PUBLIC_ORIGIN": origin, "DAYNIGHT_UNIAUTH_URL": "https://identity.example",
		"DAYNIGHT_UNIAUTH_APP_ID": rand.Text(), "DAYNIGHT_UNIAUTH_APP_SECRET": rand.Text(),
		"DAYNIGHT_UNIAUTH_CALLBACK_URL":   origin + "/api/v1/auth/callback",
		"DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN": "1", "DAYNIGHT_ALLOW_LOOPBACK_HTTP": "1",
	}
}

func testAddress(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	return address
}

func testStorageRoot(t *testing.T) string {
	t.Helper()
	temporary, err := filepath.Abs(filepath.Join("..", "..", ".tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(temporary, 0o755); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(temporary, "command-storage-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	return root
}

func processAPIEnvironment(t *testing.T) map[string]string {
	t.Helper()
	values := testEnvironment(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	schema := "process_" + strings.ToLower(rand.Text())
	if _, err := pool.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		pool.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := pool.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		pool.Close()
	})
	parsed, err := url.Parse(values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	values["DAYNIGHT_DATABASE_URL"] = parsed.String()
	return values
}

func TestRunRejectsArgumentsBeforeConfiguration(t *testing.T) {
	for _, args := range [][]string{{"unknown-secret"}, {"migrate-attachment-layout"}, {"migrate-attachment-layout", "plan"}, {"migrate-attachment-layout", "apply", "--operation-id", "secret-operation"}, {"migrate-attachment-layout", "resume", "--operation-id", "secret-operation"}} {
		var output bytes.Buffer
		reads := 0
		code := run(context.Background(), args, func(string) string { reads++; return "" }, &output)
		var event struct {
			Component  string `json:"component"`
			Phase      string `json:"phase"`
			Diagnostic string `json:"diagnostic"`
		}
		if code != 1 || reads != 0 || json.Unmarshal(output.Bytes(), &event) != nil || event.Component != "configuration" || event.Phase != "arguments" || event.Diagnostic != "command-line arguments are not supported" {
			t.Fatalf("arguments were not rejected before configuration: code=%d reads=%d output=%q", code, reads, &output)
		}
		for _, argument := range args {
			if strings.Contains(output.String(), argument) {
				t.Fatalf("argument appeared in diagnostics: %q", &output)
			}
		}
	}
}

func TestRunStartupFailures(t *testing.T) {
	for _, override := range []map[string]string{
		{"DAYNIGHT_DATABASE_URL": ""},
		{"DAYNIGHT_DATABASE_URL": "postgres://user:top-secret@bad%host/db"},
		{"DAYNIGHT_DATABASE_URL": "postgres://user:top-secret@127.0.0.1:1/db?connect_timeout=1"},
		{"DAYNIGHT_DATABASE_URL": "postgres://top-secret", "DAYNIGHT_LISTEN_ADDR": "0.0.0.0:80"},
	} {
		values := testEnvironment(t)
		for key, value := range override {
			values[key] = value
		}
		var output bytes.Buffer
		if code := run(context.Background(), nil, func(key string) string { return values[key] }, &output); code != 1 {
			t.Fatalf("startup failure returned %d", code)
		}
		if strings.Contains(output.String(), "top-secret") || !strings.Contains(output.String(), `"phase":"`) {
			t.Fatalf("unsafe or missing diagnostics: %s", &output)
		}
	}
	var output bytes.Buffer
	if code := run(context.Background(), nil, func(string) string { return "" }, &output); code != 1 || !strings.Contains(output.String(), "DAYNIGHT_DATABASE_URL is required") {
		t.Fatalf("configuration error is not actionable: %s", &output)
	}
	values := testEnvironment(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	values["DAYNIGHT_LISTEN_ADDR"] = listener.Addr().String()
	if code := run(context.Background(), nil, func(key string) string { return values[key] }, &output); code != 1 || !strings.Contains(output.String(), "HTTP listen failed") {
		t.Fatalf("occupied listener was not diagnosed: %s", &output)
	}
}

type stoppingWriter struct {
	mu      sync.Mutex
	output  bytes.Buffer
	once    sync.Once
	stop    context.CancelFunc
	address string
}

func (w *stoppingWriter) Write(value []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	result, err := w.output.Write(value)
	var event struct {
		Phase   string `json:"phase"`
		Address string `json:"address"`
	}
	if json.Unmarshal(value, &event) == nil && event.Phase == "listening" {
		w.once.Do(func() {
			w.address = event.Address
			w.stop()
		})
	}
	return result, err
}

func (w *stoppingWriter) snapshot() (string, string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.output.String(), w.address
}

func TestRunStopsAfterStartup(t *testing.T) {
	values := testEnvironment(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := &stoppingWriter{stop: cancel}
	code := run(ctx, nil, func(key string) string { return values[key] }, output)
	logs, address := output.snapshot()
	if code != 0 || !strings.Contains(logs, `"phase":"stopped"`) {
		t.Fatalf("clean shutdown returned %d: %s", code, logs)
	}
	if "http://"+address != values["DAYNIGHT_PUBLIC_ORIGIN"] {
		t.Fatal("process listener differs from its explicit callback origin")
	}
}

func TestMainUsesProcessConfigurationAndExitCode(t *testing.T) {
	t.Setenv("DAYNIGHT_DATABASE_URL", "")
	previousExit, previousArgs, previousStderr := exit, os.Args, os.Stderr
	defer func() { exit, os.Args, os.Stderr = previousExit, previousArgs, previousStderr }()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	os.Args, os.Stderr = []string{"daynight-server"}, writer
	code := -1
	exit = func(value int) { code = value }
	main()
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(reader)
	if err != nil || code != 1 || !bytes.Contains(output, []byte("DAYNIGHT_DATABASE_URL is required")) {
		t.Fatalf("process configuration exit code %d: %s, %v", code, output, err)
	}
}

type bearerTransport struct {
	token string
	next  http.RoundTripper
}

func (t bearerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	authenticated := request.Clone(request.Context())
	authenticated.Header.Set("Authorization", "Bearer "+t.token)
	return t.next.RoundTrip(authenticated)
}
