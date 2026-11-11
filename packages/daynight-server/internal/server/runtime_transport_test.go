package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/logging"
)

func startBoundaryRuntime(t *testing.T, handler http.Handler) string {
	t.Helper()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	rt, err := Start(t.Context(), "127.0.0.1:0", time.Second, time.Second, logger, handler, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- rt.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		if err := await(t, done); err != nil {
			t.Errorf("runtime: %v", err)
		}
	})
	return rt.Address()
}

func socketRequest(t *testing.T, addr, raw string) int {
	t.Helper()
	conn, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if _, err := io.WriteString(conn, raw); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	return response.StatusCode
}

func TestRuntimeRawInputBoundaries(t *testing.T) {
	var calls atomic.Int32
	addr := startBoundaryRuntime(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(http.StatusNoContent) }))
	request := func(target string) int {
		return socketRequest(t, addr, "GET "+target+" HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
	}
	for _, tc := range []struct {
		target string
		want   int
	}{
		{"/" + strings.Repeat("a", transport.MaxRequestTargetBytes-1), 204},
		{"/" + strings.Repeat("a", transport.MaxRequestTargetBytes), 414},
		{"/?" + strings.Repeat("a", transport.MaxRawQueryBytes), 204},
		{"/?" + strings.Repeat("a", transport.MaxRawQueryBytes+1), 414},
		{"/attachments/" + strings.Repeat("%F0%9F%98%80", 1024) + "?cursor=" + strings.Repeat("a", transport.MaxEncodedCursorBytes), 204},
	} {
		before := calls.Load()
		if got := request(tc.target); got != tc.want {
			t.Fatalf("target length %d: got %d want %d", len(tc.target), got, tc.want)
		}
		if tc.want == 414 && calls.Load() != before {
			t.Fatal("oversized target reached handler")
		}
	}
	prefix := "GET / HTTP/1.1\r\nHost: x\r\nX-Pad: "
	suffix := "\r\nConnection: close\r\n\r\n"
	for _, n := range []int{transport.MaxRequestHeadersBytes, transport.MaxRequestHeadersBytes + 1} {
		raw := prefix + strings.Repeat("a", n-len(prefix)-len(suffix)) + suffix
		status := socketRequest(t, addr, raw)
		if n == transport.MaxRequestHeadersBytes && status != 204 {
			t.Fatalf("header limit: %d", status)
		}
		if n > transport.MaxRequestHeadersBytes && status != 431 {
			t.Fatalf("header limit + 1: %d", status)
		}
	}
}

func TestBodyDeadlineAndKeepAliveSocket(t *testing.T) {
	entered := make(chan struct{}, 1)
	var effects atomic.Int32
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	addr := startBoundaryRuntime(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/next" {
			w.WriteHeader(204)
			return
		}
		entered <- struct{}{}
		_, err := httpx.ReadBody(w, r, transport.MaxRESTJSONBodyBytes, 200*time.Millisecond)
		if err != nil {
			httpx.WriteBodyError(w, r, logger, "test", "read", err)
			return
		}
		effects.Add(1)
		w.WriteHeader(204)
	}))
	conn, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	_, err = io.WriteString(conn, "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\nX-Request-ID: socket-test\r\n\r\n{")
	if err != nil {
		t.Fatal(err)
	}
	await(t, entered)
	reader := bufio.NewReader(conn)
	response, err := http.ReadResponse(reader, nil)
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != 408 || !response.Close || !strings.Contains(string(body), `"requestId":"socket-test"`) || effects.Load() != 0 {
		t.Fatalf("timeout response=%v body=%s effects=%d", response.Status, body, effects.Load())
	}
	if _, err := reader.ReadByte(); err != io.EOF {
		t.Fatalf("timeout connection remained usable: %v", err)
	}
	conn2, err := net.DialTimeout("tcp", addr, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn2.Close()
	_ = conn2.SetDeadline(time.Now().Add(5 * time.Second))
	reader2 := bufio.NewReader(conn2)
	_, err = fmt.Fprint(conn2, "POST / HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n\r\n{}")
	if err != nil {
		t.Fatal(err)
	}
	await(t, entered)
	first, err := http.ReadResponse(reader2, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = first.Body.Close()
	if first.StatusCode != 204 {
		t.Fatal(first.Status)
	}
	_, err = fmt.Fprint(conn2, "GET /next HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	second, err := http.ReadResponse(reader2, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = second.Body.Close()
	if second.StatusCode != 204 || effects.Load() != 1 {
		t.Fatalf("next=%v effects=%d", second.Status, effects.Load())
	}
}

func TestEarlyJSONRefusalDoesNotDrainSocket(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	addr := startBoundaryRuntime(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, err := httpx.DecodeObject(w, r)
		if err != nil {
			httpx.WriteError(w, r, logger, "test", "decode", err)
			return
		}
		t.Error("unexpected valid request")
	}))
	for _, framing := range []string{"Content-Length: 100\r\n", "Transfer-Encoding: chunked\r\n"} {
		conn, err := net.DialTimeout("tcp", addr, time.Second)
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		_, err = fmt.Fprintf(conn, "POST / HTTP/1.1\r\nHost: x\r\nContent-Type: text/plain\r\n%s\r\n", framing)
		if err != nil {
			t.Fatal(err)
		}
		response, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			t.Fatal(err)
		}
		_, err = io.Copy(io.Discard, response.Body)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		_ = conn.Close()
		if response.StatusCode != 400 || !response.Close {
			t.Fatalf("%s: %v close=%v", framing, response.Status, response.Close)
		}
	}
}
func TestRuntimeAttachmentPathAndCursorBoundary(t *testing.T) {
	project := api.Project{ID: "c3333333-3333-4333-8333-333333333333"}
	task := api.Task{ProjectID: project.ID, ID: "d4444444-4444-4444-8444-444444444444"}
	segments := make([]string, 13)
	for i := range segments {
		segments[i] = strings.Repeat("中", 78)
	}
	segments[12] = strings.Repeat("中", 76)
	path := strings.Join(segments, "/")
	if utf8.RuneCountInString(path) != attachmentcore.MaxPathCharacters {
		t.Fatal("attachment path fixture has the wrong code-point length")
	}
	if err := attachmentcore.ValidateWritePath(path); err != nil {
		t.Fatal(err)
	}
	page, err := attachmentcore.MakePage(store.AttachmentPage{Items: []model.Attachment{{Path: path}}, HasMore: true}, project.ID, task.ID)
	if err != nil || page.NextCursor == nil {
		t.Fatalf("generate attachment cursor: %v", err)
	}
	database := newHTTPTestStore(t)
	configureTransportAttachments(t, database, project.ID, task.ID, path)
	handler := projectTestHandler(t, database, io.Discard)
	addr := startBoundaryRuntime(t, handler)
	client := &http.Client{Timeout: 5 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	do := func(method, target, body string) *http.Response {
		t.Helper()
		request, err := http.NewRequest(method, "http://"+addr+target, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer "+handler.token)
		if method == http.MethodPut {
			request.Header.Set("Content-Type", "text/plain")
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	filePath := attachmentFilePath(task, path)
	if !strings.Contains(filePath, "%E4%B8%AD") {
		t.Fatal("attachment URL was not percent encoded")
	}
	put := do(http.MethodPut, filePath, "boundary-content")
	putBody, err := io.ReadAll(put.Body)
	_ = put.Body.Close()
	if err != nil || put.StatusCode != http.StatusCreated {
		t.Fatalf("put status=%d body=%s error=%v", put.StatusCode, putBody, err)
	}
	read := do(http.MethodGet, filePath, "")
	data, err := io.ReadAll(read.Body)
	_ = read.Body.Close()
	if err != nil || read.StatusCode != http.StatusOK || string(data) != "boundary-content" {
		t.Fatalf("read status=%d body=%q error=%v", read.StatusCode, data, err)
	}
	other := do(http.MethodPut, attachmentFilePath(task, "😀"), "next")
	otherBody, err := io.ReadAll(other.Body)
	_ = other.Body.Close()
	if err != nil || other.StatusCode != http.StatusCreated {
		t.Fatalf("second put status=%d body=%s error=%v", other.StatusCode, otherBody, err)
	}
	list := do(http.MethodGet, taskPath(task)+"/attachments?limit=1&cursor="+url.QueryEscape(*page.NextCursor), "")
	var result api.AttachmentPage
	err = json.NewDecoder(list.Body).Decode(&result)
	_ = list.Body.Close()
	if err != nil || list.StatusCode != http.StatusOK || len(result.Items) != 1 || result.Items[0].Path != "😀" {
		t.Fatalf("cursor list status=%d page=%+v error=%v", list.StatusCode, result, err)
	}
}

// Static DAO results keep the transport path and cursor test independent of
// persistence; actual upload and download bytes still use the local storage.
func configureTransportAttachments(t *testing.T, database *httpTestStore, projectID, taskID, path string) {
	t.Helper()
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	first := model.Attachment{ProjectID: projectID, TaskID: taskID, Path: path, ContentType: "text/plain", SizeBytes: 16, CreatedAt: at, UpdatedAt: at}
	second := model.Attachment{ProjectID: projectID, TaskID: taskID, Path: "😀", ContentType: "text/plain", SizeBytes: 4, CreatedAt: at, UpdatedAt: at}
	var ancestors []string
	segments := strings.Split(path, "/")
	for end := 1; end < len(segments); end++ {
		ancestors = append(ancestors, strings.Join(segments[:end], "/"))
	}
	conflicts := []store.AttachmentConflictQuery{{Ancestors: ancestors, DescendantPrefix: path + "/"}, {Ancestors: []string{}, DescendantPrefix: "😀/"}}
	items := []model.Attachment{first, second}
	plan := newHTTPCallPlan(t, map[string]int{"snapshot": 4, "access": 4, "presence": 4, "mutation": 2, "lock": 2, "live": 2, "conflict": 2, "put": 2, "read": 1, "list": 1})
	count := plan.Called
	var conflictIndex, putIndex atomic.Int32
	check := func(got, want any) {
		if !reflect.DeepEqual(got, want) {
			t.Errorf("transport attachment DAO arguments: got %#v, want %#v", got, want)
			panic("transport attachment DAO arguments")
		}
	}
	ids := func(project, task string) { check(project, projectID); check(task, taskID) }
	access := transportAttachmentProjectReader{access: func(_ context.Context, principal model.Principal, project string) (model.ProjectAccess, error) {
		count("access")
		check(principal, defaultHTTPPrincipal())
		check(project, projectID)
		return model.ProjectAccess{ProjectID: projectID, UserID: principal.UserID, Role: model.ProjectMemberRole}, nil
	}}
	tasks := transportAttachmentTaskReader{presence: func(_ context.Context, project, task string) (store.TaskPresence, error) {
		count("presence")
		ids(project, task)
		return store.TaskPresence{Found: true}, nil
	}}
	dao := transportAttachmentDAO{
		read: func(_ context.Context, project, task, name string) (model.Attachment, error) {
			count("read")
			ids(project, task)
			check(name, path)
			return first, nil
		},
		list: func(_ context.Context, project, task string, query store.AttachmentQuery) (store.AttachmentPage, error) {
			count("list")
			ids(project, task)
			check(query, store.AttachmentQuery{After: &path, Limit: 1})
			return store.AttachmentPage{Items: []model.Attachment{second}}, nil
		},
		conflict: func(_ context.Context, project, task string, query store.AttachmentConflictQuery) (bool, error) {
			count("conflict")
			index := int(conflictIndex.Add(1)) - 1
			ids(project, task)
			check(query, conflicts[index])
			return false, nil
		},
		put: func(_ context.Context, item model.Attachment) (model.Attachment, bool, error) {
			count("put")
			index := int(putIndex.Add(1)) - 1
			result := items[index]
			check(item, model.Attachment{ProjectID: projectID, TaskID: taskID, Path: result.Path, ContentType: result.ContentType, SizeBytes: result.SizeBytes})
			return result, true, nil
		},
	}
	database.ReadSnapshotCall = func(ctx context.Context, operation func(store.SnapshotScope) error) error {
		count("snapshot")
		snapshot := newHTTPTestSnapshot(t)
		snapshot.Projects, snapshot.Tasks, snapshot.Attachments = access, tasks, dao
		return operation(snapshot)
	}
	database.WriteAttachmentMutationCall = func(ctx context.Context, operation func(store.AttachmentMutationScope) error) (store.Completion, error) {
		count("mutation")
		err := operation(transportAttachmentMutation{
			lock: func(_ context.Context, project, task string) (store.TaskPresence, error) {
				count("lock")
				ids(project, task)
				return store.TaskPresence{Found: true}, nil
			},
			live:       func(_ context.Context, project string) error { count("live"); check(project, projectID); return nil },
			attachment: dao,
		})
		if err != nil {
			t.Errorf("transport attachment mutation callback: %v", err)
		}
		return store.Completion{Outcome: store.TransactionCommitted}, err
	}

}

type transportAttachmentProjectReader struct {
	store.ProjectReader
	access func(context.Context, model.Principal, string) (model.ProjectAccess, error)
}

func (d transportAttachmentProjectReader) ProjectAccess(ctx context.Context, principal model.Principal, id string) (model.ProjectAccess, error) {
	return d.access(ctx, principal, id)
}

type transportAttachmentTaskReader struct {
	store.TaskReader
	presence func(context.Context, string, string) (store.TaskPresence, error)
}

func (d transportAttachmentTaskReader) TaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	return d.presence(ctx, project, task)
}

type transportAttachmentMutation struct {
	store.AttachmentMutationScope
	lock       func(context.Context, string, string) (store.TaskPresence, error)
	live       func(context.Context, string) error
	attachment store.AttachmentMutationDAO
}

func (s transportAttachmentMutation) LockTaskPresence(ctx context.Context, project, task string) (store.TaskPresence, error) {
	return s.lock(ctx, project, task)
}
func (s transportAttachmentMutation) ProjectLive(ctx context.Context, project string) error {
	return s.live(ctx, project)
}
func (s transportAttachmentMutation) AttachmentDAO() store.AttachmentMutationDAO { return s.attachment }

type transportAttachmentDAO struct {
	store.AttachmentMutationDAO
	read     func(context.Context, string, string, string) (model.Attachment, error)
	list     func(context.Context, string, string, store.AttachmentQuery) (store.AttachmentPage, error)
	conflict func(context.Context, string, string, store.AttachmentConflictQuery) (bool, error)
	put      func(context.Context, model.Attachment) (model.Attachment, bool, error)
}

func (d transportAttachmentDAO) Attachment(ctx context.Context, project, task, path string) (model.Attachment, error) {
	return d.read(ctx, project, task, path)
}
func (d transportAttachmentDAO) Attachments(ctx context.Context, project, task string, query store.AttachmentQuery) (store.AttachmentPage, error) {
	return d.list(ctx, project, task, query)
}
func (d transportAttachmentDAO) AttachmentPathConflict(ctx context.Context, project, task string, query store.AttachmentConflictQuery) (bool, error) {
	return d.conflict(ctx, project, task, query)
}
func (d transportAttachmentDAO) PutAttachment(ctx context.Context, item model.Attachment) (model.Attachment, bool, error) {
	return d.put(ctx, item)
}
func TestTransportStartupFailures(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_, err = Start(context.Background(), listener.Addr().String(), time.Second, time.Second, testLogger(), http.NotFoundHandler(), nil, nil, nil, nil)
	var failure *httpx.RuntimeError
	if !errors.As(err, &failure) || failure.Phase != "listen" || errors.Unwrap(err) == nil {
		t.Fatalf("listener failure lost cause: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = Start(ctx, "127.0.0.1:0", time.Second, time.Second, testLogger(), http.NotFoundHandler(), nil, nil, nil, nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("startup cancellation lost: %v", err)
	}
	_, err = Start(context.Background(), "127.0.0.1:0", time.Second, time.Second, testLogger(), nil, nil, nil, nil, nil)
	if !errors.As(err, &failure) || failure.Phase != "composition" {
		t.Fatalf("missing handler accepted: %v", err)
	}
}

// blockedCompletionWriter controls the request completion record after the
// hijacked handler returns; lifecycle records remain writable.
type blockedCompletionWriter struct {
	entered chan struct{}
	release chan struct{}
}

func (w *blockedCompletionWriter) Write(value []byte) (int, error) {
	if strings.Contains(string(value), `"request_id":"hijack-completion"`) {
		close(w.entered)
		<-w.release
	}
	return len(value), nil
}

func TestRuntimeWaitsForHijackedRequestCompletionLog(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		name := "graceful"
		if deadline {
			name = "deadline"
		}
		t.Run(name, func(t *testing.T) {
			writer := &blockedCompletionWriter{entered: make(chan struct{}), release: make(chan struct{})}
			var releaseOnce sync.Once
			root := t.TempDir()
			output, err := logging.Open(root, writer, nil)
			if err != nil {
				t.Fatal(err)
			}
			logger := slog.New(slog.NewJSONHandler(output, nil))
			hijacked := make(chan error, 1)
			handler := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				connection, buffer, err := http.NewResponseController(w).Hijack()
				if err != nil {
					hijacked <- err
					return
				}
				_, err = buffer.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
				if err == nil {
					err = buffer.Flush()
				}
				hijacked <- errors.Join(err, connection.Close())
			})
			shutdownStarted := make(chan struct{})
			appClosed := make(chan struct{})
			budget := 5 * time.Second
			if deadline {
				budget = 100 * time.Millisecond
			}
			runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, budget, logger, handler,
				func(context.Context) error { close(shutdownStarted); return nil }, nil, nil,
				func(context.Context) error { close(appClosed); return nil })
			if err != nil {
				_ = output.Close()
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			finished := make(chan struct{})
			go func() { done <- runtime.Run(ctx); close(finished) }()
			t.Cleanup(func() {
				releaseOnce.Do(func() { close(writer.release) })
				cancel()
				select {
				case <-finished:
				case <-time.After(5 * time.Second):
					t.Error("runtime did not stop during cleanup")
					return
				}
				if !runtime.TransportDrained() {
					cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
					_ = runtime.Close(cleanup)
					done()
				}
				if !runtime.TransportDrained() {
					t.Error("transport did not drain during cleanup; retaining log lock")
					return
				}
				if err := output.Close(); err != nil {
					t.Error(err)
				}
			})
			connection, err := net.DialTimeout("tcp", runtime.Address(), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer connection.Close()
			_, err = io.WriteString(connection, "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nX-Request-ID: hijack-completion\r\n\r\n")
			if err != nil {
				t.Fatal(err)
			}
			response, err := http.ReadResponse(bufio.NewReader(connection), nil)
			if err != nil || response.StatusCode != http.StatusSwitchingProtocols {
				t.Fatalf("hijack handshake: %v %v", response, err)
			}
			if err := await(t, hijacked); err != nil {
				t.Fatal(err)
			}
			await(t, writer.entered)
			cancel()
			await(t, shutdownStarted)
			if code := runRuntimeLogLockProbe(t, root); code != 3 {
				t.Fatalf("another process acquired lock during completion logging: exit=%d", code)
			}
			if deadline {
				if err := await(t, done); !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("blocked completion should exhaust shutdown budget: %v", err)
				}
				if runtime.TransportDrained() {
					t.Fatal("transport reported drained while completion logging remained blocked")
				}
			} else {
				select {
				case err := <-done:
					t.Fatalf("runtime returned before completion logging: %v", err)
				case <-time.After(100 * time.Millisecond):
				}
			}
			select {
			case <-appClosed:
				t.Fatal("application closed before completion logging")
			default:
			}
			releaseOnce.Do(func() { close(writer.release) })
			if deadline {
				cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
				err := runtime.Close(cleanup)
				done()
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("shutdown retry lost original deadline: %v", err)
				}
			} else if err := await(t, done); err != nil {
				t.Fatalf("graceful shutdown: %v", err)
			}
			await(t, appClosed)
			if !runtime.TransportDrained() {
				t.Fatal("completed transport was not marked drained")
			}
			if err := output.Close(); err != nil {
				t.Fatal(err)
			}
			if code := runRuntimeLogLockProbe(t, root); code != 0 {
				t.Fatalf("another process could not acquire released lock: exit=%d", code)
			}
		})
	}
}

func TestRuntimeRetainsRejectedRequestLogAcrossCloseRetry(t *testing.T) {
	writer := &blockedCompletionWriter{entered: make(chan struct{}), release: make(chan struct{})}
	var releaseOnce sync.Once
	t.Cleanup(func() { releaseOnce.Do(func() { close(writer.release) }) })
	logger := slog.New(slog.NewJSONHandler(writer, nil))
	appClosed := make(chan struct{})
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, 50*time.Millisecond, logger, http.NotFoundHandler(), nil, nil, nil,
		func(context.Context) error { close(appClosed); return nil })
	if err != nil {
		t.Fatal(err)
	}
	runtime.stopAdmission()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("X-Request-ID", "hijack-completion")
	requestDone := make(chan struct{})
	go func() {
		runtime.http.Handler.ServeHTTP(response, request)
		close(requestDone)
	}()
	await(t, writer.entered)
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if err := runtime.Close(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("blocked rejected request did not exhaust shutdown: %v", err)
	}
	if runtime.TransportDrained() {
		t.Fatal("transport marked drained while rejected request logging was blocked")
	}
	// Shutdown has returned and sealed admission. A late dispatched handler
	// cannot re-enter the logger after its owner observes the drain.
	late := httptest.NewRecorder()
	runtime.http.Handler.ServeHTTP(late, request)
	if late.Code != http.StatusServiceUnavailable {
		t.Fatalf("sealed admission returned %d", late.Code)
	}
	select {
	case <-appClosed:
		t.Fatal("application closed while rejected request logging was blocked")
	default:
	}
	retried := make(chan error, 1)
	go func() { retried <- runtime.Close(context.Background()) }()
	select {
	case err := <-retried:
		t.Fatalf("close retry finished before rejected logging: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(writer.release) })
	await(t, requestDone)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("shutdown rejection returned %d", response.Code)
	}
	if err := await(t, retried); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("retry lost the original deadline: %v", err)
	}
	await(t, appClosed)
	if !runtime.TransportDrained() {
		t.Fatal("finished rejection was not drained")
	}
}

// The probe obtains the production lock from a separate process rather than
// relying on an in-process approximation of flock semantics.
func TestRuntimeLogLockProbe(t *testing.T) {
	root := os.Getenv("DAYNIGHT_TEST_RUNTIME_LOG_LOCK_ROOT")
	if root == "" {
		return
	}
	output, err := logging.Open(root, io.Discard, nil)
	if err != nil {
		var detail *logging.Error
		if errors.As(err, &detail) && detail.Phase == "lock" && detail.Cause == "busy" {
			os.Exit(3)
		}
		os.Exit(2)
	}
	if output.Close() != nil {
		os.Exit(2)
	}
	os.Exit(0)
}

func runRuntimeLogLockProbe(t *testing.T, root string) int {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, "-test.run=^TestRuntimeLogLockProbe$")
	command.Env = append(os.Environ(), "DAYNIGHT_TEST_RUNTIME_LOG_LOCK_ROOT="+root)
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			t.Fatal("lock probe did not exit")
		}
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			return exit.ExitCode()
		}
		t.Fatal(err)
	}
	return 0
}
