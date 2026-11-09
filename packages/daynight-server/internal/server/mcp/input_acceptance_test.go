package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	configpkg "github.com/codetreker/daynight/packages/daynight-server/internal/config"
	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	coretask "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	taskhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
)

type inputLog struct {
	sync.Mutex
	bytes.Buffer
}

func (l *inputLog) Write(p []byte) (int, error) { l.Lock(); defer l.Unlock(); return l.Buffer.Write(p) }
func (l *inputLog) snapshot() string            { l.Lock(); defer l.Unlock(); return l.Buffer.String() }

func TestProductionInputBodyBoundaries(t *testing.T) {
	const token = "input-boundary-secret"
	principal := model.Principal{Kind: model.PATCredential, UserID: testUserID, CredentialID: testTeamID}
	var logs inputLog
	logger := slog.New(slog.NewJSONHandler(&logs, nil))
	authenticate := func(ctx context.Context, kind model.CredentialKind, credential string) (model.Principal, error) {
		if ctx.Err() != nil || kind != model.PATCredential || credential != token {
			t.Errorf("unexpected authentication: kind=%s credential=%q", kind, credential)
		}
		return principal, nil
	}
	production := httptest.NewUnstartedServer(nil)
	origin := "http://" + production.Listener.Addr().String()
	entry, err := New(inputAuthenticator{authenticate}, "https://daynight.test", nil, logger, nil)
	if err != nil {
		t.Fatal(err)
	}
	var uploads, updates atomic.Int32
	if err := RegisterUploadTools(entry, attachmentUploadOperation(func(ctx context.Context, actor transfercore.Actor, project, task string, input mcptransfer.UploadInput) (map[string]any, error) {
		uploads.Add(1)
		expected := mcptransfer.UploadInput{Action: "inline", Path: "unchanged.txt", ContentType: "text/plain", ContentBase64: base64.StdEncoding.EncodeToString([]byte("replacement-content"))}
		if ctx.Err() != nil || actor.Principal != principal || actor.AuthorityKind != "pat" || actor.AuthorityID != principal.CredentialID || project != testProjectID || task != testTargetID || input != expected {
			t.Errorf("unexpected upload: actor=%+v project=%s task=%s input=%+v", actor, project, task, input)
		}
		return map[string]any{"state": "committed", "writeOutcome": "confirmed"}, nil
	})); err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: testTargetID, ProjectID: testProjectID, Title: "Before rejection", Status: model.TaskTodo, Version: 1, DependsOn: []string{}, ExternalDependsOn: []string{}, Properties: model.TaskProperties{}, CreatedAt: time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC), UpdatedAt: time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)}
	operations := &inputTaskOperations{t: t, update: func(ctx context.Context, actual model.Principal, project, id string, input coretask.UpdateTask) (model.Task, error) {
		updates.Add(1)
		title := task.Title
		if ctx.Err() != nil || actual != principal || project != testProjectID || id != testTargetID || !reflect.DeepEqual(input, coretask.UpdateTask{Version: task.Version, Title: &title}) {
			t.Errorf("unexpected Task update: principal=%+v project=%s task=%s input=%+v", actual, project, id, input)
		}
		return task, nil
	}}
	authentication, err := authhttp.NewRequestAuthentication(authenticate, configpkg.AuthSettings{PublicOrigin: origin, AllowHTTPTestOrigin: true}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.Handle("/mcp", entry)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	taskhttp.TaskRoutes(mux, operations, authentication, logger)
	completed := make(chan error, 1)
	observed := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r)
		if r.Header.Get("X-Input-Test") == "yes" {
			completed <- r.Context().Err()
		}
	})
	production.Config.Handler = httpx.RequestLogging(logger, httpx.LimitRequestTarget(logger, observed))
	production.Start()
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := entry.Shutdown(ctx); err != nil {
			t.Error(err)
		}
		production.Close()
	})
	encode := func(v any) string {
		t.Helper()
		data, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	initialize := `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"input-boundary","version":"1"}}}`
	upload := encode(map[string]any{"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": map[string]any{"name": "task_attachment_put", "arguments": map[string]any{"projectId": testProjectID, "taskId": testTargetID, "action": "inline", "path": "unchanged.txt", "contentType": "text/plain", "contentBase64": base64.StdEncoding.EncodeToString([]byte("replacement-content"))}}})
	patch := encode(map[string]any{"version": task.Version, "title": task.Title})
	rejectedPatch := encode(map[string]any{"version": task.Version, "title": "Rejected mutation"})
	for _, chunked := range []bool{false, true} {
		for _, input := range []struct {
			name, method, path, valid, rejected string
			limit, status                       int
		}{
			{"mcp", http.MethodPost, "/mcp", initialize, upload, transport.MaxMCPJSONBodyBytes, http.StatusOK},
			{"rest", http.MethodPatch, "/api/v1/projects/" + testProjectID + "/tasks/" + testTargetID, patch, rejectedPatch, httpx.MaxJSONBody, http.StatusOK},
		} {
			t.Run(fmt.Sprintf("%s/chunked=%v", input.name, chunked), func(t *testing.T) {
				beforeUploads, beforeUpdates := uploads.Load(), updates.Load()
				id := fmt.Sprintf("input-%s-over-%v", input.name, chunked)
				response, data, contextErr := inputSocket(t, production.Listener.Addr().String(), token, completed, input.method, input.path, input.rejected+strings.Repeat(" ", input.limit+1-len(input.rejected)), chunked, true, id, !chunked)
				if response.StatusCode != http.StatusRequestEntityTooLarge || (chunked && !response.Close) || !bytes.Contains(data, []byte(`"code":"payload_too_large"`)) || !bytes.Contains(data, []byte(id)) {
					t.Fatalf("over limit: status=%d close=%v body=%q context=%v", response.StatusCode, response.Close, data, contextErr)
				}
				if uploads.Load() != beforeUploads || updates.Load() != beforeUpdates {
					t.Fatal("rejected input invoked a business operation")
				}
				id = fmt.Sprintf("input-%s-exact-%v", input.name, chunked)
				response, data, contextErr = inputSocket(t, production.Listener.Addr().String(), token, completed, input.method, input.path, input.valid+strings.Repeat(" ", input.limit-len(input.valid)), chunked, true, id, true)
				if response.StatusCode != input.status || contextErr != nil {
					t.Fatalf("exact limit: status=%d body=%q context=%v", response.StatusCode, data, contextErr)
				}
				expectedUpdates := beforeUpdates
				if input.name == "rest" {
					expectedUpdates++
				}
				if uploads.Load() != beforeUploads || updates.Load() != expectedUpdates {
					t.Fatalf("exact body calls: uploads=%d updates=%d", uploads.Load(), updates.Load())
				}
			})
		}
	}
	for _, input := range []struct {
		method, path, body string
		limit              int
	}{
		{http.MethodPost, "/mcp", upload, transport.MaxMCPJSONBodyBytes},
		{http.MethodPatch, "/api/v1/projects/" + testProjectID + "/tasks/" + testTargetID, rejectedPatch, httpx.MaxJSONBody},
	} {
		beforeUploads, beforeUpdates := uploads.Load(), updates.Load()
		response, data, contextErr := inputSocket(t, production.Listener.Addr().String(), token, completed, input.method, input.path, input.body+strings.Repeat(" ", input.limit+1-len(input.body)), true, false, "input-no-terminator", false)
		if response.StatusCode != http.StatusRequestEntityTooLarge || !response.Close || contextErr == nil || !bytes.Contains(data, []byte(`"code":"payload_too_large"`)) {
			t.Fatalf("unfinished chunked rejection: status=%d close=%v body=%q context=%v", response.StatusCode, response.Close, data, contextErr)
		}
		if uploads.Load() != beforeUploads || updates.Load() != beforeUpdates {
			t.Fatal("unfinished rejected body invoked a business operation")
		}
	}
	response, data, _ := inputSocket(t, production.Listener.Addr().String(), token, completed, http.MethodPost, "/mcp", upload, false, true, "input-upload-after-rejection", true)
	if response.StatusCode != http.StatusOK || bytes.Contains(data, []byte(`"isError":true`)) || uploads.Load() != 1 || updates.Load() != 2 {
		t.Fatalf("valid upload could not reacquire admission: status=%d body=%q uploads=%d updates=%d", response.StatusCode, data, uploads.Load(), updates.Load())
	}
	for _, secret := range []string{token, "replacement-content", base64.StdEncoding.EncodeToString([]byte("replacement-content"))} {
		if strings.Contains(logs.snapshot(), secret) {
			t.Fatal("input rejection logs exposed credentials or file content")
		}
	}
}

type inputAuthenticator struct {
	authenticate func(context.Context, model.CredentialKind, string) (model.Principal, error)
}

func (a inputAuthenticator) Authenticate(ctx context.Context, kind model.CredentialKind, token string) (model.Principal, error) {
	return a.authenticate(ctx, kind, token)
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
