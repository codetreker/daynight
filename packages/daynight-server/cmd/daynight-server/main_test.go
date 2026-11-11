//go:build startupshutdown

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testEnvironment(t *testing.T) map[string]string {
	t.Helper()
	return testEnvironmentAt(t, testAddress(t))
}

func lookupTestEnvironment(values map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) { value, ok := values[key]; return value, ok }
}

func writeTestConfig(t *testing.T, root string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "config.yml"), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func testEnvironmentAt(t *testing.T, address string) map[string]string {
	t.Helper()
	url := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
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
	return processAPIEnvironmentAt(t, testAddress(t))
}

func processAPIEnvironmentAt(t *testing.T, address string) map[string]string {
	t.Helper()
	values := testEnvironmentAt(t, address)
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
		code := run(context.Background(), args, func(string) (string, bool) { reads++; return "", false }, &output)
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

func TestCommandRootSelection(t *testing.T) {
	for _, tc := range []struct {
		name          string
		args          []string
		env           map[string]string
		command, root string
		invalid       bool
	}{
		{name: "default", command: "server", root: "/var/lib/daynight"},
		{name: "environment", env: map[string]string{"DAYNIGHT_ROOT": "/environment"}, command: "server", root: "/environment"},
		{name: "flag takes precedence", args: []string{"--root=/flag"}, env: map[string]string{"DAYNIGHT_ROOT": "invalid"}, command: "server", root: "/flag"},
		{name: "verify", args: []string{"verify-storage", "--root", "/backup"}, command: "verify-storage", root: "/backup"},
		{name: "empty flag", args: []string{"--root="}, invalid: true},
		{name: "empty environment", env: map[string]string{"DAYNIGHT_ROOT": ""}, invalid: true},
		{name: "relative", args: []string{"--root", "relative-secret"}, invalid: true},
		{name: "control", args: []string{"--root", "/root\nsecret"}, invalid: true},
		{name: "duplicate", args: []string{"--root", "/one", "--root=/two"}, invalid: true},
		{name: "extra", args: []string{"--root=/one", "secret"}, invalid: true},
		{name: "wrong order", args: []string{"--root=/one", "verify-storage"}, invalid: true},
		{name: "unknown flag", args: []string{"--secret=value"}, invalid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			command, root, err := parseCommand(tc.args, lookupTestEnvironment(tc.env))
			if tc.invalid {
				if err == nil {
					t.Fatal("invalid arguments accepted")
				}
				return
			}
			if err != nil || command != tc.command || root != tc.root {
				t.Fatalf("command=%q root=%q error=%v", command, root, err)
			}
		})
	}
}

func TestConfigurationFailureIsSafeAndIdentifiesRun(t *testing.T) {
	root := testStorageRoot(t)
	if err := os.Mkdir(filepath.Join(root, "config"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "config.yml"), []byte("database:\n  url: [sensitive-yaml-value\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if code := run(t.Context(), []string{"--root", root}, lookupTestEnvironment(nil), &output); code != 1 {
		t.Fatalf("code=%d", code)
	}
	var event struct {
		RunID     string `json:"run_id"`
		PID       int    `json:"pid"`
		Command   string `json:"command"`
		Component string `json:"component"`
		Phase     string `json:"phase"`
	}
	if err := json.Unmarshal(output.Bytes(), &event); err != nil {
		t.Fatalf("decode log: %v", err)
	}
	if !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(event.RunID) || event.PID != os.Getpid() || event.Command != "server" || event.Component != "configuration" || event.Phase != "decode" {
		t.Fatalf("unexpected configuration event: %s", output.String())
	}
	if strings.Contains(output.String(), "sensitive-yaml-value") || strings.Contains(output.String(), root) {
		t.Fatalf("unsafe diagnostic: %s", output.String())
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
		if code := run(context.Background(), []string{"--root", testStorageRoot(t)}, lookupTestEnvironment(values), &output); code != 1 {
			t.Fatalf("startup failure returned %d", code)
		}
		if strings.Contains(output.String(), "top-secret") || !strings.Contains(output.String(), `"phase":"`) {
			t.Fatalf("unsafe or missing diagnostics: %s", &output)
		}
	}
	var output bytes.Buffer
	if code := run(context.Background(), []string{"--root", testStorageRoot(t)}, lookupTestEnvironment(nil), &output); code != 1 || !strings.Contains(output.String(), "database.url is required") {
		t.Fatalf("configuration error is not actionable: %s", &output)
	}
	values := testEnvironment(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	values["DAYNIGHT_LISTEN_ADDR"] = listener.Addr().String()
	if code := run(context.Background(), []string{"--root", testStorageRoot(t)}, lookupTestEnvironment(values), &output); code != 1 || !strings.Contains(output.String(), "HTTP listen failed") {
		t.Fatalf("occupied listener was not diagnosed: %s", &output)
	}
	t.Run("worker startup failure", func(t *testing.T) {
		values := processAPIEnvironment(t)
		cfg, err := config.LoadServer(testStorageRoot(t), lookupTestEnvironment(values))
		if err != nil {
			t.Fatal(err)
		}
		output := &persistenceProcessLog{}
		logger := slog.New(slog.NewJSONHandler(output, nil))
		startup, cancelStartup := context.WithTimeout(t.Context(), cfg.Server.StartupTimeout)
		defer cancelStartup()
		app, err := service.OpenAppWithLogger(startup, cfg, logger)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			cleanup, cancel := context.WithTimeout(context.Background(), cfg.Server.ShutdownTimeout)
			defer cancel()
			if err := app.Close(cleanup); err != nil {
				t.Error(err)
			}
		})
		// A second Start produces a deterministic worker startup failure after
		// the serving lifecycle has acquired its real listener.
		if err := app.Start(t.Context()); err != nil {
			t.Fatal(err)
		}
		if code := serveApp(t.Context(), startup, cancelStartup, cfg, app, logger); code != 1 {
			t.Fatalf("worker startup failure returned %d", code)
		}
		if !strings.Contains(output.String(), `"phase":"startup"`) || strings.Contains(output.String(), `"phase":"listening"`) {
			t.Fatalf("worker startup failure diagnostics: %s", output.String())
		}
		if err := app.Ready(t.Context()); err == nil {
			t.Fatal("worker startup failure retained database resources")
		}
		listener, err := net.Listen("tcp", cfg.Server.ListenAddress)
		if err != nil {
			t.Fatalf("worker startup failure retained listener: %v", err)
		}
		if err := listener.Close(); err != nil {
			t.Fatal(err)
		}
	})
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
	root := testStorageRoot(t)
	writeTestConfig(t, root, map[string]any{
		"server":   map[string]any{"listen_address": values["DAYNIGHT_LISTEN_ADDR"], "public_origin": values["DAYNIGHT_PUBLIC_ORIGIN"], "allow_http_test_origin": true},
		"database": map[string]any{"url": values["DAYNIGHT_DATABASE_URL"]},
		"storage":  map[string]any{"root": values["DAYNIGHT_STORAGE_ROOT"]},
		"uniauth":  map[string]any{"url": values["DAYNIGHT_UNIAUTH_URL"], "app_id": values["DAYNIGHT_UNIAUTH_APP_ID"], "app_secret": values["DAYNIGHT_UNIAUTH_APP_SECRET"], "callback_url": values["DAYNIGHT_UNIAUTH_CALLBACK_URL"], "allow_loopback_http": true},
	})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := &stoppingWriter{stop: cancel}
	code := run(ctx, []string{"--root", root}, lookupTestEnvironment(nil), output)
	logs, address := output.snapshot()
	if code != 0 || !strings.Contains(logs, `"phase":"stopped"`) || !strings.Contains(logs, `"event":"configuration_loaded"`) {
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
	os.Args, os.Stderr = []string{"daynight-server", "--root", testStorageRoot(t)}, writer
	code := -1
	exit = func(value int) { code = value }
	main()
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	output, err := io.ReadAll(reader)
	if err != nil || code != 1 || !bytes.Contains(output, []byte("database.url is required")) {
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
