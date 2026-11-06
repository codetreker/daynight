package session

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	v2 "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol/v2"
)

func testLogger() *slog.Logger { return slog.New(slog.NewTextHandler(io.Discard, nil)) }

type failingResponseWriter struct{ header http.Header }

func (w *failingResponseWriter) Header() http.Header     { return w.header }
func (*failingResponseWriter) WriteHeader(int)           {}
func (*failingResponseWriter) Write([]byte) (int, error) { return 0, errors.New("write failed") }

func TestArchiveBodyRejectsInvalidInputs(t *testing.T) {
	for _, test := range []struct {
		name, kind, query, body string
		fail                    bool
	}{
		{"valid", "application/json", "", "{}", false},
		{"charset", "application/json; charset=utf-8", "", "{}", false},
		{"media", "text/plain", "", "{}", true},
		{"wrong charset", "application/json; charset=utf-16", "", "{}", true},
		{"query", "application/json", "?bad=1", "{}", true},
		{"oversize", "application/json", "", strings.Repeat("a", sp.MaxArchiveBytes+1), true},
	} {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, "/archive"+test.query, strings.NewReader(test.body))
			req.Header.Set("Content-Type", test.kind)
			_, err := archiveBody(httptest.NewRecorder(), req)
			if (err != nil) != test.fail {
				t.Fatal(err)
			}
		})
	}
	req := httptest.NewRequest(http.MethodPut, "/archive", nil)
	req.Header.Set("Content-Type", "application/json")
	req.Body = io.NopCloser(archiveBrokenReader{})
	if _, err := archiveBody(httptest.NewRecorder(), req); err == nil {
		t.Fatal("read error ignored")
	}
}

type archiveBrokenReader struct{}

func (archiveBrokenReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func TestTerminalProtocolSelection(t *testing.T) {
	for _, tc := range []struct {
		header    []string
		protocols string
		want      string
		bad       bool
	}{
		{want: sp.Protocol}, {header: []string{v2.Protocol}, want: v2.Protocol},
		{header: []string{""}, bad: true}, {header: []string{"future"}, bad: true},
		{header: []string{sp.Protocol, v2.Protocol}, bad: true},
		{protocols: v2.Protocol, want: v2.Protocol}, {protocols: "other", bad: true},
		{protocols: sp.Protocol + ", " + v2.Protocol, want: v2.Protocol},
		{header: []string{sp.Protocol}, protocols: v2.Protocol, bad: true},
	} {
		r := httptest.NewRequest(http.MethodGet, "http://example.test/channel", nil)
		if tc.header != nil {
			r.Header[v2.ProtocolHeader] = tc.header
		}
		if tc.protocols != "" {
			r.Header.Set("Sec-WebSocket-Protocol", tc.protocols)
		}
		got, err := selectedSessionProtocol(r)
		if (err != nil) != tc.bad || !tc.bad && got != tc.want {
			t.Fatalf("%+v: %q %v", tc, got, err)
		}
	}
}

func TestSessionResultHandlesCancellationEncodingAndWriteFailure(t *testing.T) {
	routes := &Routes{logger: testLogger()}
	request := httptest.NewRequest(http.MethodGet, "/api/v1/test-sessions", nil)
	ctx, cancel := context.WithCancel(request.Context())
	cancel()
	canceled := httptest.NewRecorder()
	routes.Result(canceled, request.WithContext(ctx), http.StatusOK, map[string]string{"text": "unused"}, nil)
	if canceled.Body.Len() != 0 || len(canceled.Header()) != 0 {
		t.Fatal("canceled request wrote a response")
	}
	invalid := httptest.NewRecorder()
	routes.Result(invalid, request, http.StatusOK, make(chan int), nil)
	if invalid.Code != http.StatusInternalServerError {
		t.Fatal("encoding failure did not become a response error")
	}
	routes.Result(&failingResponseWriter{header: make(http.Header)}, request, http.StatusOK, map[string]string{"text": "<>&"}, nil)
}

func TestChannelAdmissionFailureDuringShutdown(t *testing.T) {
	for _, tc := range []struct {
		name, code, message, retry string
		closing                    bool
		err                        error
		status                     int
	}{
		{"active unavailable", "internal_error", "internal server error", "", false, &model.Fault{Code: "service_unavailable", Message: "private detail"}, http.StatusInternalServerError},
		{"closing unavailable", "rate_limited", "Session channel capacity is unavailable.", "60", true, &model.Fault{Code: "service_unavailable", Message: "private detail"}, http.StatusTooManyRequests},
		{"closing forbidden", "forbidden", "not allowed", "", true, &model.Fault{Code: "forbidden", Message: "not allowed"}, http.StatusForbidden},
		{"closing operational error", "internal_error", "internal server error", "", true, errors.New("private detail"), http.StatusInternalServerError},
	} {
		t.Run(tc.name, func(t *testing.T) {
			routes := NewRoutes(nil, nil, testLogger())
			routes.closing = tc.closing
			response := httptest.NewRecorder()
			routes.channelAdmissionFailure(response, httptest.NewRequest(http.MethodGet, "/channel", nil), tc.err)
			var body api.ErrorResponse
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if response.Code != tc.status || body.Error.Code != tc.code || body.Error.Message != tc.message || response.Header().Get("Retry-After") != tc.retry {
				t.Fatalf("admission response: status=%d body=%+v retry=%q", response.Code, body.Error, response.Header().Get("Retry-After"))
			}
		})
	}
}

// Block inside Hijack to exercise capacity before the connection enters the map.
type blockedSessionUpgrade struct {
	*httptest.ResponseRecorder
	entered, release chan struct{}
}

func (w *blockedSessionUpgrade) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	close(w.entered)
	<-w.release
	return nil, nil, errors.New("bounded upgrade failure")
}
func TestSessionChannelReservesPendingUpgradeCapacity(t *testing.T) {
	routes := NewRoutes(nil, nil, testLogger())
	routes.reserved = relayMaxConnections - 1
	request := httptest.NewRequest(http.MethodGet, "http://daynight.example.com/channel", nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	writer := &blockedSessionUpgrade{httptest.NewRecorder(), make(chan struct{}), make(chan struct{})}
	done := make(chan error, 1)
	go func() { _, _, _, err := routes.accept(writer, request); done <- err }()
	select {
	case <-writer.entered:
	case <-time.After(time.Second):
		close(writer.release)
		t.Fatal("upgrade did not reach hijack")
	}
	_, _, _, err := routes.accept(httptest.NewRecorder(), request)
	close(writer.release)
	if err == nil || !strings.Contains(err.Error(), "capacity") {
		t.Fatal("pending upgrade did not reserve capacity", err)
	}
	if err := <-done; err == nil {
		t.Fatal("failed upgrade succeeded")
	}
	routes.mutex.Lock()
	reserved := routes.reserved
	routes.mutex.Unlock()
	if reserved != relayMaxConnections-1 {
		t.Fatal("failed upgrade leaked reservation", reserved)
	}
}

func TestSessionShutdownRetriesPendingUpgradeDrain(t *testing.T) {
	routes := NewRoutes(nil, nil, testLogger())
	request := httptest.NewRequest(http.MethodGet, "http://daynight.example.com/channel", nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	request.Header.Set("Sec-WebSocket-Version", "13")
	request.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
	writer := &blockedSessionUpgrade{httptest.NewRecorder(), make(chan struct{}), make(chan struct{})}
	t.Cleanup(func() {
		select {
		case <-writer.release:
		default:
			close(writer.release)
		}
	})
	upgradeDone := make(chan error, 1)
	go func() { _, _, _, err := routes.accept(writer, request); upgradeDone <- err }()
	select {
	case <-writer.entered:
	case <-time.After(time.Second):
		t.Fatal("upgrade did not reach hijack")
	}
	deadline, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := routes.Shutdown(deadline); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown did not wait for pending upgrade: %v", err)
	}
	drained := routes.drained
	if _, _, _, err := routes.accept(httptest.NewRecorder(), request); err == nil || !strings.Contains(err.Error(), "capacity") {
		t.Fatalf("shutdown admitted new channel: %v", err)
	}
	canceled, cancelRetry := context.WithCancel(context.Background())
	cancelRetry()
	if err := routes.Shutdown(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("retry did not wait for pending upgrade: %v", err)
	}
	if routes.drained != drained {
		t.Fatal("shutdown retry replaced the drain state")
	}
	close(writer.release)
	select {
	case err := <-upgradeDone:
		if err == nil {
			t.Fatal("failed upgrade succeeded")
		}
	case <-time.After(time.Second):
		t.Fatal("upgrade did not finish")
	}
	retry, cancelRetry := context.WithTimeout(context.Background(), time.Second)
	defer cancelRetry()
	if err := routes.Shutdown(retry); err != nil {
		t.Fatalf("shutdown retry failed after upgrade finished: %v", err)
	}
}

func TestSessionShutdownRetainsOnlyDrainErrors(t *testing.T) {
	routes := NewRoutes(nil, nil, testLogger())
	ordinary := errors.New("ordinary disconnect")
	first := errors.New("controller disconnect")
	second := errors.New("terminal disconnect")
	routes.recordDrainError(ordinary)
	routes.active.Add(1)
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if err := routes.Shutdown(canceled); !errors.Is(err, context.Canceled) {
		t.Fatalf("shutdown did not wait for active connection: %v", err)
	} else if _, ok := err.(interface{ Drained() bool }); ok {
		t.Fatalf("unfinished drain reported completion: %v", err)
	}
	routes.recordDrainError(first)
	routes.recordDrainError(second)
	routes.active.Done()
	ctx, cancelRetry := context.WithTimeout(context.Background(), time.Second)
	defer cancelRetry()
	for i := 0; i < 2; i++ {
		err := routes.Shutdown(ctx)
		if !errors.Is(err, first) || !errors.Is(err, second) || errors.Is(err, ordinary) {
			t.Fatalf("shutdown %d returned wrong disconnect failures: %v", i, err)
		}
		if !strings.Contains(err.Error(), first.Error()) || !strings.Contains(err.Error(), second.Error()) {
			t.Fatalf("shutdown %d lost disconnect diagnostics: %v", i, err)
		}
		if completed, ok := err.(interface{ Drained() bool }); !ok || !completed.Drained() {
			t.Fatalf("shutdown %d did not report completed drain: %v", i, err)
		}
	}
}

func TestSessionRoutesFrameBounds(t *testing.T) {
	if err := relayWrite(context.Background(), nil, make(chan int)); err == nil {
		t.Fatal("serialized unsupported response")
	}
	if err := relayWrite(context.Background(), nil, map[string]any{"body": strings.Repeat("x", sp.MaxFrameBytes)}); err == nil {
		t.Fatal("sent oversized frame")
	}
}

func TestActiveConnectionsTracksWebSocketLifecycle(t *testing.T) {
	routes := NewRoutes(nil, nil, testLogger())
	ready := make(chan struct{})
	closed := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, ctx, cleanup, err := routes.accept(w, r)
		if err != nil {
			close(closed)
			return
		}
		close(ready)
		<-conn.CloseRead(ctx).Done()
		cleanup()
		close(closed)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, server.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	// The client can finish the upgrade before accept registers the connection.
	select {
	case <-ready:
	case <-ctx.Done():
		t.Fatal("connection was not registered")
	}
	if count := routes.ActiveConnections(); count != 1 {
		t.Fatalf("connected count = %d", count)
	}
	if err := conn.CloseNow(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("connection did not close")
	}
	if count := routes.ActiveConnections(); count != 0 {
		t.Fatalf("closed count = %d", count)
	}
}
