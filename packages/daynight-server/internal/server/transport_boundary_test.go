package server

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/transport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
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
