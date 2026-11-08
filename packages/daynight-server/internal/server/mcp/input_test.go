package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
)

type observedInput struct {
	io.ReadCloser
	entered chan<- struct{}
	reads   *atomic.Int32
	once    sync.Once
}

func (b *observedInput) Read(p []byte) (int, error) {
	b.reads.Add(1)
	b.once.Do(func() { b.entered <- struct{}{} })
	return b.ReadCloser.Read(p)
}

type gatedInput struct {
	entered chan<- struct{}
	release <-chan struct{}
	reads   atomic.Int32
}

func (b *gatedInput) Read([]byte) (int, error) {
	b.reads.Add(1)
	b.entered <- struct{}{}
	<-b.release
	return 0, io.EOF
}
func (*gatedInput) Close() error { return nil }

func inputEntry(t *testing.T) *Entry {
	t.Helper()
	e, err := New(testAuthenticator{}, "https://daynight.test", nil, slog.New(slog.NewTextHandler(io.Discard, nil)), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := e.Shutdown(ctx); err != nil {
			t.Error(err)
		}
	})
	return e
}

func inputRequest(body io.ReadCloser) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/mcp", body)
	r.Header.Set("Authorization", "Bearer alice")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "application/json, text/event-stream")
	return r
}

func receiveInput(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func TestInputAdmissionRejectsBeforeReadingAndReleases(t *testing.T) {
	e := inputEntry(t)
	entered := make(chan struct{}, transport.MaxMCPInputOperations)
	release := make(chan struct{})
	done := make(chan struct{}, transport.MaxMCPInputOperations)
	for i := 0; i < transport.MaxMCPInputOperations; i++ {
		body := &gatedInput{entered: entered, release: release}
		go func() {
			e.ServeHTTP(httptest.NewRecorder(), inputRequest(body))
			done <- struct{}{}
		}()
	}
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	for i := 0; i < transport.MaxMCPInputOperations; i++ {
		receiveInput(t, entered, "admitted body read")
	}
	rejected := &gatedInput{entered: entered, release: release}
	response := httptest.NewRecorder()
	e.ServeHTTP(response, inputRequest(rejected))
	if response.Code != http.StatusTooManyRequests || rejected.reads.Load() != 0 {
		t.Fatalf("capacity rejection = %d, reads = %d", response.Code, rejected.reads.Load())
	}
	close(release)
	for i := 0; i < transport.MaxMCPInputOperations; i++ {
		receiveInput(t, done, "completed body read")
	}
	if got := len(e.input); got != 0 {
		t.Fatalf("input slots retained after parse failures: %d", got)
	}
	response = httptest.NewRecorder()
	e.ServeHTTP(response, inputRequest(io.NopCloser(strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`))))
	if response.Code != http.StatusOK || len(e.input) != 0 {
		t.Fatalf("initialize status = %d, retained slots = %d, body = %s", response.Code, len(e.input), response.Body.String())
	}
}

func TestInputOversizeSkipsDispatchAndReleases(t *testing.T) {
	e := inputEntry(t)
	var calls atomic.Int32
	schema := map[string]any{"type": "object"}
	if err := e.RegisterTool(&sdk.Tool{Name: "input_probe", InputSchema: schema, OutputSchema: schema}, BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		calls.Add(1)
		return ToolResult{Data: map[string]any{"ok": true}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	finished := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.ServeHTTP(w, r)
		finished <- struct{}{}
	}))
	t.Cleanup(server.Close)
	client := server.Client()
	client.Timeout = 5 * time.Second
	base := `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"input_probe","arguments":{}}}`
	body := base + strings.Repeat(" ", transport.MaxMCPJSONBodyBytes+1-len(base))
	for _, chunked := range []bool{false, true} {
		request, err := http.NewRequest(http.MethodPost, server.URL, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Authorization", "Bearer alice")
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Accept", "application/json, text/event-stream")
		if chunked {
			request.ContentLength = -1
			request.TransferEncoding = []string{"chunked"}
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		if err != nil || closeErr != nil || response.StatusCode != http.StatusRequestEntityTooLarge || !strings.Contains(string(data), `"code":"payload_too_large"`) {
			t.Fatalf("chunked=%v status=%d body=%q errors=%v %v", chunked, response.StatusCode, data, err, closeErr)
		}
		receiveInput(t, finished, "over-limit HTTP completion")
		if calls.Load() != 0 || len(e.input) != 0 || len(e.budget.control) != 0 {
			t.Fatalf("chunked=%v calls=%d input=%d control=%d", chunked, calls.Load(), len(e.input), len(e.budget.control))
		}
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	result, err := materializationCall(ctx, server.URL, "input-reacquire", "input_probe")
	if err != nil || result.Result.IsError {
		t.Fatalf("valid tool after rejection: %+v %v", result, err)
	}
	receiveInput(t, finished, "valid tool HTTP completion")
	if calls.Load() != 1 || len(e.input) != 0 || len(e.budget.control) != 0 {
		t.Fatalf("valid tool calls=%d input=%d control=%d", calls.Load(), len(e.input), len(e.budget.control))
	}
}

func TestInputAndControlBudgetsAreIndependent(t *testing.T) {
	e := inputEntry(t)
	entered := make(chan struct{}, transport.MaxMCPInputOperations)
	release := make(chan struct{})
	done := make(chan error, transport.MaxMCPInputOperations)
	schema := map[string]any{"type": "object"}
	err := e.RegisterTool(&sdk.Tool{Name: "blocked_control", InputSchema: schema, OutputSchema: schema}, BudgetControl, func(context.Context, RequestActor, json.RawMessage) (ToolResult, error) {
		entered <- struct{}{}
		<-release
		return ToolResult{Data: map[string]any{"ok": true}}, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	served := make(chan struct{}, transport.MaxMCPInputOperations)
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.ServeHTTP(w, r)
		served <- struct{}{}
	})))
	t.Cleanup(server.Close)
	for i := 0; i < transport.MaxMCPInputOperations; i++ {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			result, err := materializationCall(ctx, server.URL, "control", "blocked_control")
			if err == nil && result.Result.IsError {
				err = fmt.Errorf("control returned an error: %#v", result)
			}
			done <- err
		}()
	}
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
	})
	for i := 0; i < transport.MaxMCPInputOperations; i++ {
		receiveInput(t, entered, "control handler")
	}
	close(release)
	for i := 0; i < transport.MaxMCPInputOperations; i++ {
		select {
		case err := <-done:
			if err != nil {
				t.Error(err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("timed out waiting for control completion")
		}
	}
	for i := 0; i < transport.MaxMCPInputOperations; i++ {
		receiveInput(t, served, "HTTP completion")
	}
	if len(e.input) != 0 {
		t.Fatalf("input slots retained: %d", len(e.input))
	}
}

func TestInputAdmissionOnSocketAndCancellation(t *testing.T) {
	e := inputEntry(t)
	entered := make(chan struct{}, transport.MaxMCPInputOperations+1)
	finished := make(chan struct{}, transport.MaxMCPInputOperations+1)
	var rejectedReads atomic.Int32
	var admittedReads atomic.Int32
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		counter := &admittedReads
		if r.Header.Get("X-Test-Rejected") == "yes" {
			counter = &rejectedReads
		}
		r.Body = &observedInput{ReadCloser: r.Body, entered: entered, reads: counter}
		e.ServeHTTP(w, r)
		finished <- struct{}{}
	})))
	t.Cleanup(server.Close)
	address := server.Listener.Addr().String()
	connections := make([]net.Conn, 0, transport.MaxMCPInputOperations)
	t.Cleanup(func() {
		for _, c := range connections {
			_ = c.Close()
		}
	})
	for i := 0; i < transport.MaxMCPInputOperations; i++ {
		c, err := net.DialTimeout("tcp", address, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		connections = append(connections, c)
		_, err = io.WriteString(c, "POST /mcp HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer alice\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n")
		if err != nil {
			t.Fatal(err)
		}
		receiveInput(t, entered, "socket body read")
	}
	c, err := net.DialTimeout("tcp", address, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(5 * time.Second))
	_, err = io.WriteString(c, "POST /mcp HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer alice\r\nX-Test-Rejected: yes\r\nContent-Length: 100\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusTooManyRequests || !response.Close || rejectedReads.Load() != 0 {
		t.Fatalf("rejection: status %d, close %v, reads %d", response.StatusCode, response.Close, rejectedReads.Load())
	}
	receiveInput(t, finished, "capacity rejection")
	for _, conn := range connections {
		_ = conn.Close()
	}
	for i := 0; i < transport.MaxMCPInputOperations; i++ {
		receiveInput(t, finished, "canceled socket")
	}
	if len(e.input) != 0 {
		t.Fatalf("input slots retained after disconnects: %d", len(e.input))
	}
}

func TestInputSocketTimeoutReleasesSlot(t *testing.T) {
	e := inputEntry(t)
	served := make(chan struct{}, 1)
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		e.ServeHTTP(w, r)
		served <- struct{}{}
	})))
	t.Cleanup(server.Close)
	c, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetDeadline(time.Now().Add(transport.JSONBodyReadTimeout + 5*time.Second))
	_, err = io.WriteString(c, "POST /mcp HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer alice\r\nContent-Type: application/json\r\nX-Request-ID: mcp-timeout\r\nContent-Length: 100\r\n\r\n{")
	if err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(c), nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if err != nil || response.StatusCode != http.StatusRequestTimeout || !response.Close || !strings.Contains(string(data), "mcp-timeout") {
		t.Fatalf("timeout response: status=%d close=%v body=%q read=%v", response.StatusCode, response.Close, data, err)
	}
	receiveInput(t, served, "timeout completion")
	if len(e.input) != 0 {
		t.Fatalf("input slot retained after timeout: %d", len(e.input))
	}
}

func TestShutdownInterruptsInputSocketRead(t *testing.T) {
	e := inputEntry(t)
	entered, served := make(chan struct{}, 1), make(chan struct{}, 1)
	var reads atomic.Int32
	server := httptest.NewServer(httpx.RequestLogging(slog.New(slog.NewTextHandler(io.Discard, nil)), http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = &observedInput{ReadCloser: r.Body, entered: entered, reads: &reads}
		e.ServeHTTP(w, r)
		served <- struct{}{}
	})))
	t.Cleanup(server.Close)
	c, err := net.DialTimeout("tcp", server.Listener.Addr().String(), 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_, err = io.WriteString(c, "POST /mcp HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer alice\r\nContent-Length: 100\r\n\r\n")
	if err != nil {
		t.Fatal(err)
	}
	receiveInput(t, entered, "pending read before shutdown")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := e.Shutdown(ctx); err != nil {
		t.Fatalf("shutdown did not interrupt input: %v", err)
	}
	receiveInput(t, served, "interrupted input completion")
	if len(e.input) != 0 {
		t.Fatalf("input slot retained after shutdown: %d", len(e.input))
	}
}
