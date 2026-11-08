package mcp_test

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coreproject "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	coretask "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/testdata/testsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
)

type inputLog struct {
	sync.Mutex
	bytes.Buffer
}

func (l *inputLog) Write(p []byte) (int, error) {
	l.Lock()
	defer l.Unlock()
	return l.Buffer.Write(p)
}

func (l *inputLog) snapshot() string {
	l.Lock()
	defer l.Unlock()
	return l.Buffer.String()
}

type inputStorage struct {
	*local.Storage
	puts atomic.Int32
}

func (s *inputStorage) Put(ctx context.Context, bucket, path string, body io.Reader) (filestorage.FileInfo, error) {
	s.puts.Add(1)
	return s.Storage.Put(ctx, bucket, path, body)
}

func TestProductionInputBodyBoundaries(t *testing.T) {
	database := testsupport.TestStore(t)
	storageRoot := filepath.Join(testauth.Directory(t), "storage")
	storage, err := local.New(storageRoot)
	if err != nil {
		t.Fatal(err)
	}
	files := &inputStorage{Storage: storage}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	production := httptest.NewUnstartedServer(nil)
	origin := "http://" + production.Listener.Addr().String()
	callback := origin + "/api/v1/auth/callback"
	gateway := testauth.StartGateway(t, callback)
	cfg := configpkg.Config{
		DatabaseURL: database.Pool.Config().ConnString(), StorageRoot: storageRoot,
		ListenAddress: production.Listener.Addr().String(), PublicOrigin: origin,
		StartupTimeout: 5 * time.Second, ShutdownTimeout: 5 * time.Second, TaskSyncOverlap: 10 * time.Second,
		UniAuthURL: gateway.Origin, UniAuthAppID: gateway.AppID, UniAuthAppSecret: gateway.AppSecret,
		UniAuthCallbackURL: callback, AllowHTTPTestOrigin: true, AllowLoopbackHTTP: true,
		MCPTempBudgetBytes: 8 << 30,
	}
	identity, err := service.NewIdentityClient(cfg)
	if err != nil {
		t.Fatal(err)
	}
	app := service.NewModules(cfg, database, database.Ready, files, identity)
	var logs inputLog
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	handler, err := server.New(app, cfg, logger)
	if err != nil {
		t.Fatal(err)
	}
	completed := make(chan error, 1)
	observed := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r)
		if r.Header.Get("X-Input-Test") == "yes" {
			completed <- r.Context().Err()
		}
	})
	production.Config.Handler = httpx.RequestLogging(logger, httpx.LimitRequestTarget(logger, observed))
	production.Start()
	t.Cleanup(func() {
		production.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := handler.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	browser := testauth.Browser(t)
	testauth.Login(t, browser, origin, "alice")
	token := testauth.CreatePAT(t, browser, origin)
	principal, err := app.Identity.Authenticate(t.Context(), model.PATCredential, token)
	if err != nil {
		t.Fatal(err)
	}
	project, err := app.Projects.Create(t.Context(), principal, coreproject.CreateProject{Name: "Input boundary", RepoURL: "https://example.com/input-boundary", ExpectedUserID: principal.UserID})
	if err != nil {
		t.Fatal(err)
	}
	task, err := app.Tasks.Create(t.Context(), principal, project.ID, coretask.CreateTask{Title: "Before rejection"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := app.Attachments.Put(t.Context(), principal, project.ID, task.ID, "unchanged.txt", "text/plain", strings.NewReader("original-content")); err != nil {
		t.Fatal(err)
	}
	state := func() string {
		t.Helper()
		var value string
		err := database.Pool.QueryRow(t.Context(), `SELECT jsonb_build_object('projects',(SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM projects p),'tasks',(SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM tasks t),'attachments',(SELECT jsonb_agg(to_jsonb(a) ORDER BY task_id,path) FROM task_attachments a),'transfers',(SELECT jsonb_agg(to_jsonb(x) ORDER BY id) FROM private_transfers x),'ledger',(SELECT to_jsonb(l) FROM private_transfer_ledger l))::text`).Scan(&value)
		if err != nil {
			t.Fatal(err)
		}
		return value
	}
	fileState := func() map[string][32]byte {
		t.Helper()
		result := map[string][32]byte{}
		err := filepath.WalkDir(storageRoot, func(path string, entry fs.DirEntry, err error) error {
			if err != nil || entry.IsDir() {
				return err
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			result[path] = sha256.Sum256(data)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	encode := func(v any) string {
		t.Helper()
		data, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"input-boundary","version":"1"}}}`
	upload := encode(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": "task_attachment_put", "arguments": map[string]any{"projectId": project.ID, "taskId": task.ID, "action": "inline", "path": "unchanged.txt", "contentType": "text/plain", "contentBase64": base64.StdEncoding.EncodeToString([]byte("replacement-content"))}}})
	patch := encode(map[string]any{"version": task.Version, "title": task.Title})
	rejectedPatch := encode(map[string]any{"version": task.Version, "title": "Rejected mutation"})
	for _, chunked := range []bool{false, true} {
		for _, input := range []struct {
			name, method, path, valid, rejected string
			limit                               int
			status                              int
		}{
			{"mcp", http.MethodPost, "/mcp", initialize, upload, transport.MaxMCPJSONBodyBytes, http.StatusOK},
			{"rest", http.MethodPatch, "/api/v1/projects/" + project.ID + "/tasks/" + task.ID, patch, rejectedPatch, httpx.MaxJSONBody, http.StatusOK},
		} {
			t.Run(fmt.Sprintf("%s/chunked=%v", input.name, chunked), func(t *testing.T) {
				before, beforeFiles, beforePuts := state(), fileState(), files.puts.Load()
				id := fmt.Sprintf("input-%s-over-%v", input.name, chunked)
				response, data, contextErr := inputSocket(t, production.Listener.Addr().String(), token, completed, input.method, input.path, input.rejected+strings.Repeat(" ", input.limit+1-len(input.rejected)), chunked, true, id, !chunked)
				if response.StatusCode != http.StatusRequestEntityTooLarge || (chunked && !response.Close) || !bytes.Contains(data, []byte(`"code":"payload_too_large"`)) || !bytes.Contains(data, []byte(id)) {
					t.Fatalf("over limit: status=%d close=%v body=%q context=%v", response.StatusCode, response.Close, data, contextErr)
				}
				if state() != before || !reflect.DeepEqual(fileState(), beforeFiles) || files.puts.Load() != beforePuts {
					t.Fatal("rejected input changed database rows, file bytes, or entered storage Put")
				}
				id = fmt.Sprintf("input-%s-exact-%v", input.name, chunked)
				response, data, contextErr = inputSocket(t, production.Listener.Addr().String(), token, completed, input.method, input.path, input.valid+strings.Repeat(" ", input.limit-len(input.valid)), chunked, true, id, true)
				if response.StatusCode != input.status || contextErr != nil {
					t.Fatalf("exact limit: status=%d body=%q context=%v", response.StatusCode, data, contextErr)
				}
			})
		}
	}
	for _, input := range []struct {
		method, path, body string
		limit              int
	}{
		{http.MethodPost, "/mcp", upload, transport.MaxMCPJSONBodyBytes},
		{http.MethodPatch, "/api/v1/projects/" + project.ID + "/tasks/" + task.ID, rejectedPatch, httpx.MaxJSONBody},
	} {
		before, beforeFiles, beforePuts := state(), fileState(), files.puts.Load()
		response, data, contextErr := inputSocket(t, production.Listener.Addr().String(), token, completed, input.method, input.path, input.body+strings.Repeat(" ", input.limit+1-len(input.body)), true, false, "input-no-terminator", false)
		if response.StatusCode != http.StatusRequestEntityTooLarge || !response.Close || contextErr == nil || !bytes.Contains(data, []byte(`"code":"payload_too_large"`)) {
			t.Fatalf("unfinished chunked rejection: status=%d close=%v body=%q context=%v", response.StatusCode, response.Close, data, contextErr)
		}
		if state() != before || !reflect.DeepEqual(fileState(), beforeFiles) || files.puts.Load() != beforePuts {
			t.Fatal("unfinished rejected body changed database rows or files")
		}
	}
	beforeFiles, beforePuts := fileState(), files.puts.Load()
	response, data, _ := inputSocket(t, production.Listener.Addr().String(), token, completed, http.MethodPost, "/mcp", upload, false, true, "input-upload-after-rejection", true)
	if response.StatusCode != http.StatusOK || bytes.Contains(data, []byte(`"isError":true`)) || files.puts.Load() != beforePuts+1 || reflect.DeepEqual(fileState(), beforeFiles) {
		t.Fatalf("valid upload could not reacquire admission or publish: status=%d body=%q puts=%d", response.StatusCode, data, files.puts.Load())
	}
	for _, secret := range []string{token, "replacement-content", "original-content", base64.StdEncoding.EncodeToString([]byte("replacement-content"))} {
		if strings.Contains(logs.snapshot(), secret) {
			t.Fatal("input rejection logs exposed credentials or file content")
		}
	}
}

func inputSocket(t *testing.T, address, token string, completed <-chan error, method, path, body string, chunked, terminate bool, id string, keepalive bool) (*http.Response, []byte, error) {
	t.Helper()
	connection, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatal(err)
	}
	header := fmt.Sprintf("%s %s HTTP/1.1\r\nHost: %s\r\nAuthorization: Bearer %s\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nX-Input-Test: yes\r\nX-Request-ID: %s\r\n", method, path, address, token, id)
	if chunked {
		header += "Transfer-Encoding: chunked\r\n\r\n" + fmt.Sprintf("%x\r\n", len(body))
	} else {
		header += fmt.Sprintf("Content-Length: %d\r\n\r\n", len(body))
	}
	if _, err := io.WriteString(connection, header); err != nil {
		t.Fatal(err)
	}
	written := make(chan error, 1)
	go func() {
		payload := body
		if chunked {
			payload += "\r\n"
			if terminate {
				payload += "0\r\n\r\n"
			}
		}
		_, err := io.WriteString(connection, payload)
		written <- err
	}()
	reader := bufio.NewReader(connection)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil {
		t.Fatalf("read input response: %v %v", err, closeErr)
	}
	if err := <-written; err != nil && response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("write accepted request: %v", err)
	}
	var contextErr error
	select {
	case contextErr = <-completed:
	case <-time.After(5 * time.Second):
		t.Fatal("input handler did not complete")
	}
	if keepalive {
		if response.Close {
			t.Fatal("successful body closed its connection")
		}
		if _, err := fmt.Fprintf(connection, "GET /healthz HTTP/1.1\r\nHost: %s\r\n\r\n", address); err != nil {
			t.Fatal(err)
		}
		next, err := http.ReadResponse(reader, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(io.Discard, next.Body); err != nil {
			t.Fatal(err)
		}
		if err := next.Body.Close(); err != nil || next.StatusCode != http.StatusOK {
			t.Fatalf("keepalive follow-up status=%d error=%v", next.StatusCode, err)
		}
	}
	return response, data, contextErr
}
