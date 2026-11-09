package prompt

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
)

type observedBody struct {
	io.ReadCloser
	once    sync.Once
	started chan struct{}
}

func (b *observedBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.started) })
	return b.ReadCloser.Read(p)
}

func promptSocket(t *testing.T, address string) net.Conn {
	t.Helper()
	conn, err := net.DialTimeout("tcp", address, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.SetDeadline(time.Now().Add(22 * time.Second)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

func awaitPrompt(t *testing.T, signal <-chan struct{}, timeout time.Duration) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(timeout):
		t.Fatal("timed out waiting for prompt handler")
	}
}

func promptSocketServer(t *testing.T, wrap func(http.Handler) http.Handler) (*httptest.Server, *fakePrompts) {
	t.Helper()
	service := &fakePrompts{}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	mux := http.NewServeMux()
	RegisterRoutes(mux, service, fakeAuth{}, logger)
	server := httptest.NewServer(httpx.RequestLogging(logger, wrap(mux)))
	t.Cleanup(server.Close)
	return server, service
}

func TestPromptBodySocketTimeout(t *testing.T) {
	started, done := make(chan struct{}), make(chan struct{})
	server, service := promptSocketServer(t, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer close(done)
			r.Body = &observedBody{ReadCloser: r.Body, started: started}
			next.ServeHTTP(w, r)
		})
	})
	conn := promptSocket(t, server.Listener.Addr().String())
	_, err := io.WriteString(conn, "PUT /api/v1/me/worker-prompt HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\nX-Request-ID: prompt-socket\r\n\r\n{")
	if err != nil {
		t.Fatal(err)
	}
	awaitPrompt(t, started, time.Second)
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
	awaitPrompt(t, done, time.Second)
	if response.StatusCode != http.StatusRequestTimeout || !response.Close || !strings.Contains(string(body), `"request_timeout"`) || !strings.Contains(string(body), `"requestId":"prompt-socket"`) || service.puts != 0 {
		t.Fatalf("timeout response=%v body=%s calls=%d", response.Status, body, service.puts)
	}
	if _, err := reader.ReadByte(); err != io.EOF {
		t.Fatalf("connection remained usable: %v", err)
	}
}

func TestPromptBodySocketCancellation(t *testing.T) {
	started, done := make(chan struct{}), make(chan struct{})
	cancelRequest := make(chan context.CancelFunc, 1)
	server, service := promptSocketServer(t, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer close(done)
			ctx, cancel := context.WithCancel(r.Context())
			defer cancel()
			cancelRequest <- cancel
			r.Body = &observedBody{ReadCloser: r.Body, started: started}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	})
	conn := promptSocket(t, server.Listener.Addr().String())
	_, err := fmt.Fprint(conn, "PUT /api/v1/me/worker-prompt HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{")
	if err != nil {
		t.Fatal(err)
	}
	awaitPrompt(t, started, time.Second)
	(<-cancelRequest)()
	awaitPrompt(t, done, 2*time.Second)
	if service.puts != 0 {
		t.Fatal("canceled read invoked prompt service")
	}
}

func TestPromptBodySocketOversize(t *testing.T) {
	done := make(chan struct{})
	server, service := promptSocketServer(t, func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer close(done)
			next.ServeHTTP(w, r)
		})
	})
	conn := promptSocket(t, server.Listener.Addr().String())
	// Leave one chunk byte and the terminator unsent so EOF cannot race the limit.
	_, err := fmt.Fprintf(conn, "PUT /api/v1/me/worker-prompt HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nX-Request-ID: prompt-large\r\n\r\n%x\r\n%s", httpx.MaxJSONBody+2, strings.Repeat("x", httpx.MaxJSONBody+1))
	if err != nil {
		t.Fatal(err)
	}
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
	awaitPrompt(t, done, time.Second)
	if response.StatusCode != http.StatusRequestEntityTooLarge || !response.Close || !strings.Contains(string(body), `"payload_too_large"`) || !strings.Contains(string(body), `"requestId":"prompt-large"`) || service.puts != 0 {
		t.Fatalf("oversize response=%v body=%s calls=%d", response.Status, body, service.puts)
	}
	if _, err := reader.ReadByte(); err != io.EOF {
		t.Fatalf("connection remained usable: %v", err)
	}
}
