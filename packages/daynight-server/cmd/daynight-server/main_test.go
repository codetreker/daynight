package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
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

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func testEnvironment(t *testing.T) map[string]string {
	t.Helper()
	url := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if url == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	address := acceptanceAddress(t)
	origin := "http://" + address
	return map[string]string{
		"DAYNIGHT_DATABASE_URL": url, "DAYNIGHT_STORAGE_ROOT": testStorageRoot(t), "DAYNIGHT_LISTEN_ADDR": address,
		"DAYNIGHT_PUBLIC_ORIGIN": origin, "DAYNIGHT_UNIAUTH_URL": "https://identity.example",
		"DAYNIGHT_UNIAUTH_APP_ID": rand.Text(), "DAYNIGHT_UNIAUTH_APP_SECRET": rand.Text(),
		"DAYNIGHT_UNIAUTH_CALLBACK_URL":   origin + "/api/v1/auth/callback",
		"DAYNIGHT_ALLOW_HTTP_TEST_ORIGIN": "1", "DAYNIGHT_ALLOW_LOOPBACK_HTTP": "1",
	}
}

func testStorageRoot(t *testing.T) string {
	t.Helper()
	root := newTestStorageRoot(t)
	t.Cleanup(func() {
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	return root
}

func newTestStorageRoot(t *testing.T) string {
	t.Helper()
	root, err := os.MkdirTemp(filepath.Dir(binaryAcceptance.path), "process-storage-")
	if err != nil {
		t.Fatal(err)
	}
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
		if code := run(context.Background(), nil, func(key string) string { return values[key] }, io.Discard, &output); code != 1 {
			t.Fatalf("startup failure returned %d", code)
		}
		if strings.Contains(output.String(), "top-secret") || !strings.Contains(output.String(), `"phase":"`) {
			t.Fatalf("unsafe or missing diagnostics: %s", &output)
		}
	}
	var output bytes.Buffer
	if code := run(context.Background(), nil, func(string) string { return "" }, io.Discard, &output); code != 1 || !strings.Contains(output.String(), "DAYNIGHT_DATABASE_URL is required") {
		t.Fatalf("configuration error is not actionable: %s", &output)
	}
	values := testEnvironment(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	values["DAYNIGHT_LISTEN_ADDR"] = listener.Addr().String()
	if code := run(context.Background(), nil, func(key string) string { return values[key] }, io.Discard, &output); code != 1 || !strings.Contains(output.String(), "HTTP listen failed") {
		t.Fatalf("occupied listener was not diagnosed: %s", &output)
	}
}

type stoppingWriter struct {
	bytes.Buffer
	once sync.Once
	stop context.CancelFunc
}

func (w *stoppingWriter) Write(value []byte) (int, error) {
	result, err := w.Buffer.Write(value)
	if bytes.Contains(value, []byte(`"phase":"listening"`)) {
		w.once.Do(w.stop)
	}
	return result, err
}

func TestRunStopsAfterStartup(t *testing.T) {
	values := testEnvironment(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := &stoppingWriter{stop: cancel}
	if code := run(ctx, nil, func(key string) string { return values[key] }, io.Discard, output); code != 0 || !strings.Contains(output.String(), `"phase":"stopped"`) {
		t.Fatalf("clean shutdown returned %d: %s", code, output.String())
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

type startupWriter struct {
	mu      sync.Mutex
	output  bytes.Buffer
	started chan string
}

func (w *startupWriter) Write(value []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	result, err := w.output.Write(value)
	var event struct {
		Phase   string `json:"phase"`
		Address string `json:"address"`
	}
	if json.Unmarshal(value, &event) == nil && event.Phase == "listening" {
		w.started <- event.Address
	}
	return result, err
}

func TestRunServesProjectAndTaskAPI(t *testing.T) {
	values := processAPIEnvironment(t)
	gateway := testauth.StartGateway(t, values["DAYNIGHT_UNIAUTH_CALLBACK_URL"])
	values["DAYNIGHT_UNIAUTH_URL"], values["DAYNIGHT_UNIAUTH_APP_ID"], values["DAYNIGHT_UNIAUTH_APP_SECRET"] = gateway.Origin, gateway.AppID, gateway.AppSecret
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	output := &startupWriter{started: make(chan string, 1)}
	finished := make(chan int, 1)
	stopped := make(chan struct{})
	go func() {
		finished <- run(ctx, nil, func(key string) string { return values[key] }, io.Discard, output)
		close(stopped)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-stopped:
		case <-time.After(5 * time.Second):
			t.Error("owned in-process server did not stop during cleanup")
		}
	})
	var address string
	select {
	case address = <-output.started:
	case code := <-finished:
		t.Fatalf("process failed during startup: %d", code)
	case <-time.After(5 * time.Second):
		t.Fatal("server did not start")
	}
	if "http://"+address != values["DAYNIGHT_PUBLIC_ORIGIN"] {
		t.Fatal("process listener differs from its explicit callback origin")
	}
	browser := testauth.Browser(t)
	testauth.Login(t, browser, values["DAYNIGHT_PUBLIC_ORIGIN"], "alice")
	token := testauth.CreatePAT(t, browser, values["DAYNIGHT_PUBLIC_ORIGIN"])
	browser.CloseIdleConnections()
	client := &http.Client{Timeout: 3 * time.Second, Transport: acceptanceBearerTransport{token: token, next: http.DefaultTransport}}
	response, err := client.Get("http://" + address + "/api/v1/projects")
	if err != nil {
		t.Fatal(err)
	}
	var page api.ProjectPage
	err = json.NewDecoder(response.Body).Decode(&page)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || page.Items == nil || response.Header.Get("X-Request-ID") == "" {
		t.Fatalf("project API was not wired: %d %+v %v", response.StatusCode, page, err)
	}
	response, err = client.Post("http://"+address+"/api/v1/projects", "application/json", strings.NewReader(`{"name":null}`))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusBadRequest || !bytes.Contains(body, []byte(`"code":"invalid_input"`)) {
		t.Fatalf("project create route was not wired: %d %s %v", response.StatusCode, body, err)
	}
	response, err = client.Post("http://"+address+"/api/v1/projects", "application/json", strings.NewReader(`{"name":"Process tasks","repoUrl":"https://github.com/example/process"}`))
	if err != nil {
		t.Fatal(err)
	}
	var project api.Project
	err = json.NewDecoder(response.Body).Decode(&project)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusCreated {
		t.Fatalf("process project create: %d %v", response.StatusCode, err)
	}
	tasksURL := "http://" + address + "/api/v1/projects/" + project.ID + "/tasks"
	response, err = client.Post(tasksURL, "application/json", strings.NewReader(`{"title":"Process task"}`))
	if err != nil {
		t.Fatal(err)
	}
	var task api.Task
	err = json.NewDecoder(response.Body).Decode(&task)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusCreated || task.ProjectID != project.ID || task.Title != "Process task" || task.Status != "todo" || !task.Ready || task.Version != 1 {
		t.Fatalf("process task create: %d %+v %v", response.StatusCode, task, err)
	}
	for index, status := range []string{"in_progress", "done"} {
		request, requestErr := http.NewRequest(http.MethodPut, tasksURL+"/"+task.ID+"/status", strings.NewReader(fmt.Sprintf(`{"version":%d,"status":%q}`, task.Version, status)))
		if requestErr != nil {
			t.Fatal(requestErr)
		}
		request.Header.Set("Content-Type", "application/json")
		response, err = client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		err = json.NewDecoder(response.Body).Decode(&task)
		response.Body.Close()
		if err != nil || response.StatusCode != http.StatusOK || task.Status != status || task.Version != int64(index+2) {
			t.Fatalf("process task status %s: %d %+v %v", status, response.StatusCode, task, err)
		}
	}
	response, err = client.Get(tasksURL + "?status=done&ready=false")
	if err != nil {
		t.Fatal(err)
	}
	var tasks api.TaskPage
	err = json.NewDecoder(response.Body).Decode(&tasks)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || len(tasks.Items) != 1 || tasks.Items[0].ID != task.ID {
		t.Fatalf("process task list: %d %+v %v", response.StatusCode, tasks, err)
	}
	cancel()
	select {
	case code := <-finished:
		if code != 0 {
			t.Fatalf("process did not stop cleanly: %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("server did not stop")
	}
}

type acceptanceBearerTransport struct {
	token string
	next  http.RoundTripper
}

func (t acceptanceBearerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	authenticated := request.Clone(request.Context())
	authenticated.Header.Set("Authorization", "Bearer "+t.token)
	return t.next.RoundTrip(authenticated)
}
