package attachment_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/appsupport"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type persistenceRequestGate struct {
	mu       sync.Mutex
	active   int
	draining bool
	drained  chan struct{}
}

func (g *persistenceRequestGate) wrap(handler http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		if g.draining {
			g.mu.Unlock()
			http.Error(w, "server shutting down", http.StatusServiceUnavailable)
			return
		}
		g.active++
		g.mu.Unlock()
		defer func() {
			g.mu.Lock()
			defer g.mu.Unlock()
			g.active--
			if g.draining && g.active == 0 {
				close(g.drained)
			}
		}()
		handler.ServeHTTP(w, r)
	})
}

func (g *persistenceRequestGate) beginDrain() {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.draining {
		g.draining = true
		if g.active == 0 {
			close(g.drained)
		}
	}
}

func attachmentPersistenceJSON[T any](t *testing.T, status int, body []byte, want int) T {
	t.Helper()
	if status != want {
		t.Fatalf("HTTP status %d, want %d: %s", status, want, body)
	}
	var result T
	if err := json.Unmarshal(body, &result); err != nil {
		t.Fatal(err)
	}
	return result
}

func attachmentPersistenceStore(t *testing.T, safeToClose *bool) *postgres.Store {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	databaseURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required for PostgreSQL tests")
	}
	admin, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	schema := "attachment_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	var database *postgres.Store
	t.Cleanup(func() {
		defer admin.Close()
		if !*safeToClose {
			t.Error("active HTTP handlers did not drain; test schema was retained")
			return
		}
		if database != nil {
			database.Close()
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if _, err := admin.Exec(cleanup, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	parsed, err := url.Parse(databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	query.Set("timezone", "UTC")
	query.Set("application_name", schema)
	parsed.RawQuery = query.Encode()
	database, err = postgres.Open(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	return database
}

func TestAttachmentHTTPPersistsAcrossServiceReconstruction(t *testing.T) {
	safeToCloseFiles := true
	database := attachmentPersistenceStore(t, &safeToCloseFiles)
	databaseURL := database.Pool.Config().ConnString()
	scratch := filepath.Join("..", "..", "..", "..", "..", ".tmp")
	if err := os.MkdirAll(scratch, 0o700); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(scratch, "attachment-persistence-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !safeToCloseFiles {
			t.Error("active HTTP handlers did not drain; attachment directory was retained")
			return
		}
		if err := os.RemoveAll(root); err != nil {
			t.Error(err)
		}
	})
	files, err := local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if safeToCloseFiles && files != nil {
			_ = files.Close()
		}
	}()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	address := listener.Addr().String()
	origin := "http://" + address
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	config := configpkg.Config{DatabaseURL: "postgres://database", StorageRoot: root, ListenAddress: address, StartupTimeout: 5 * time.Second, ShutdownTimeout: time.Second, TaskSyncOverlap: 10 * time.Second, PublicOrigin: origin, UniAuthURL: gateway.Origin, UniAuthAppID: gateway.AppID, UniAuthAppSecret: gateway.AppSecret, UniAuthCallbackURL: callback, AllowHTTPTestOrigin: true, AllowLoopbackHTTP: true}
	start := func(listener net.Listener, database *postgres.Store, files *local.Storage) (*http.Server, <-chan error, *persistenceRequestGate) {
		t.Helper()
		handler, err := appsupport.NewHandler(config, database, database.Ready, files, slog.New(slog.NewJSONHandler(io.Discard, nil)))
		if err != nil {
			listener.Close()
			t.Fatal(err)
		}
		gate := &persistenceRequestGate{drained: make(chan struct{})}
		server := &http.Server{Handler: gate.wrap(handler), ReadHeaderTimeout: 5 * time.Second}
		done := make(chan error, 1)
		go func() { done <- server.Serve(listener) }()
		return server, done, gate
	}
	running := false
	stop := func(server *http.Server, done <-chan error, gate *persistenceRequestGate) (bool, error) {
		gate.beginDrain()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		shutdownErr := server.Shutdown(ctx)
		cancel()
		var closeErr error
		if shutdownErr != nil {
			closeErr = server.Close()
		}
		waitCtx, waitCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer waitCancel()
		drained, exited := false, false
		drainedCh := gate.drained
		var serveErr error
		for !drained || !exited {
			select {
			case err := <-done:
				exited = true
				done = nil
				if !errors.Is(err, http.ErrServerClosed) {
					serveErr = err
					if serveErr == nil {
						serveErr = errors.New("HTTP server exited without a shutdown error")
					}
				}
			case <-drainedCh:
				drained = true
				drainedCh = nil
			case <-waitCtx.Done():
				return drained, errors.Join(shutdownErr, closeErr, serveErr, waitCtx.Err())
			}
		}
		return true, errors.Join(shutdownErr, closeErr, serveErr)
	}
	server, done, gate := start(listener, database, files)
	running = true
	safeToCloseFiles = false
	defer func() {
		if running {
			var stopErr error
			safeToCloseFiles, stopErr = stop(server, done, gate)
			if stopErr != nil {
				t.Errorf("stop HTTP server: %v", stopErr)
			}
		}
		if safeToCloseFiles && database != nil {
			database.Close()
		} else if !safeToCloseFiles {
			t.Error("active HTTP handlers did not drain; dependencies were not closed by this cleanup")
		}
	}()
	browser := testauth.Browser(t)
	testauth.Login(t, browser, origin, "alice")
	token := testauth.CreatePAT(t, browser, origin)
	client := &http.Client{Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	request := func(method, path, contentType string, data []byte) (int, []byte) {
		t.Helper()
		req, err := http.NewRequest(method, origin+path, bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		if contentType != "" {
			req.Header.Set("Content-Type", contentType)
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		if err != nil || closeErr != nil {
			t.Fatalf("read response: %v, close: %v", err, closeErr)
		}
		return response.StatusCode, body
	}
	jsonRequest := func(method, path string, value any) (int, []byte) {
		t.Helper()
		data, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return request(method, path, "application/json", data)
	}
	status, body := request(http.MethodGet, "/api/v1/me", "", nil)
	user := attachmentPersistenceJSON[api.User](t, status, body, http.StatusOK)
	status, body = jsonRequest(http.MethodPost, "/api/v1/projects", api.CreateProjectRequest{Name: "Attachment persistence", RepoURL: "https://example.com/persistence", ExpectedUserID: user.ID})
	project := attachmentPersistenceJSON[api.Project](t, status, body, http.StatusCreated)
	status, body = jsonRequest(http.MethodPost, taskCollection(project.ID), map[string]any{"title": "Attachment task", "description": "Preserve task state"})
	task := attachmentPersistenceJSON[api.Task](t, status, body, http.StatusCreated)
	contents := map[string][]byte{"plan.md": []byte("persistence\n"), "nested/data.bin": {0, 1, 255, 13, 10}}
	for name, data := range contents {
		status, body = request(http.MethodPut, attachmentFilePath(task, name), "application/octet-stream", data)
		attachmentPersistenceJSON[api.Attachment](t, status, body, http.StatusCreated)
	}
	status, body = request(http.MethodGet, taskPath(task), "", nil)
	if actual := attachmentPersistenceJSON[api.Task](t, status, body, http.StatusOK); !reflect.DeepEqual(actual, task) {
		t.Fatalf("upload changed task: %#v", actual)
	}
	list := func() api.AttachmentPage {
		t.Helper()
		status, body := request(http.MethodGet, taskPath(task)+"/attachments", "", nil)
		return attachmentPersistenceJSON[api.AttachmentPage](t, status, body, http.StatusOK)
	}
	metadata := list()
	if len(metadata.Items) != len(contents) || metadata.NextCursor != nil {
		t.Fatalf("initial attachment metadata: %#v", metadata)
	}
	for _, next := range []string{"in_progress", "todo", "done"} {
		before := task
		status, body = jsonRequest(http.MethodPut, taskPath(task)+"/status", api.TaskStatusUpdateRequest{Version: before.Version, Status: next})
		task = attachmentPersistenceJSON[api.Task](t, status, body, http.StatusOK)
		preserved := task
		preserved.StartedAt, preserved.CompletedAt = before.StartedAt, before.CompletedAt
		preserved.Status, preserved.Ready, preserved.Version, preserved.UpdatedAt = before.Status, before.Ready, before.Version, before.UpdatedAt
		if task.Status != next || task.Version != before.Version+1 || !task.UpdatedAt.After(before.UpdatedAt) || !reflect.DeepEqual(preserved, before) {
			t.Fatalf("%s changed unrelated task data: before=%#v after=%#v", next, before, task)
		}
		if actual := list(); !reflect.DeepEqual(actual, metadata) {
			t.Fatalf("%s changed attachment metadata: %#v", next, actual)
		}
		for name, want := range contents {
			status, body = request(http.MethodGet, attachmentFilePath(task, name), "", nil)
			if status != http.StatusOK || !bytes.Equal(body, want) {
				t.Fatalf("%s changed attachment %s: %d", next, name, status)
			}
		}
	}
	var stopErr error
	safeToCloseFiles, stopErr = stop(server, done, gate)
	running = false
	if stopErr != nil {
		t.Fatalf("stop HTTP server: %v", stopErr)
	}
	database.Close()
	database = nil
	if err := files.Close(); err != nil {
		t.Fatal(err)
	}
	files = nil
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	database, err = postgres.Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	files, err = local.New(root)
	if err != nil {
		t.Fatal(err)
	}
	listener, err = net.Listen("tcp", address)
	if err != nil {
		t.Fatalf("listener not released for reuse: %v", err)
	}
	if listener.Addr().String() != address {
		listener.Close()
		t.Fatalf("listener address changed: %s", listener.Addr())
	}
	server, done, gate = start(listener, database, files)
	running = true
	safeToCloseFiles = false
	if actual := list(); !reflect.DeepEqual(actual, metadata) {
		t.Fatalf("reconstructed service changed metadata: %#v", actual)
	}
	status, body = request(http.MethodGet, taskPath(task), "", nil)
	if actual := attachmentPersistenceJSON[api.Task](t, status, body, http.StatusOK); !reflect.DeepEqual(actual, task) {
		t.Fatalf("reconstructed service changed task: %#v", actual)
	}
	for name, want := range contents {
		status, body = request(http.MethodGet, attachmentFilePath(task, name), "", nil)
		if status != http.StatusOK || !bytes.Equal(body, want) {
			t.Fatalf("reconstructed service changed %s: %d", name, status)
		}
	}
	safeToCloseFiles, stopErr = stop(server, done, gate)
	running = false
	if stopErr != nil {
		t.Fatalf("stop reconstructed HTTP server: %v", stopErr)
	}
}
