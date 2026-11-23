//go:build integration

package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

type proxyConnKey struct{}

type proxyBackend struct {
	proxy     *httputil.ReverseProxy
	transport *http.Transport
	ctx       context.Context
	cancel    context.CancelFunc
	active    sync.WaitGroup
	conns     map[net.Conn]int
}

type publicProxy struct {
	origin  string
	t       *testing.T
	mu      sync.RWMutex
	backend *proxyBackend
}

func newPublicProxy(t *testing.T) *publicProxy {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	p := &publicProxy{origin: "http://" + listener.Addr().String(), t: t}
	server := &http.Server{
		Handler: p, ReadHeaderTimeout: 5 * time.Second,
		ConnContext: func(ctx context.Context, conn net.Conn) context.Context {
			return context.WithValue(ctx, proxyConnKey{}, conn)
		},
	}
	exited := make(chan error, 1)
	go func() { exited <- server.Serve(listener) }()
	t.Cleanup(func() {
		defer func() {
			if err := server.Close(); err != nil {
				t.Errorf("close public proxy: %v", err)
			}
			select {
			case err := <-exited:
				if !errors.Is(err, http.ErrServerClosed) {
					t.Errorf("public proxy exited: %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Error("public proxy did not exit")
			}
		}()
		p.clearBackend()
	})
	return p
}

func (p *publicProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	p.mu.Lock()
	backend := p.backend
	if backend == nil {
		p.mu.Unlock()
		http.Error(w, "integration backend unavailable", http.StatusServiceUnavailable)
		return
	}
	conn := r.Context().Value(proxyConnKey{}).(net.Conn)
	backend.conns[conn]++
	backend.active.Add(1)
	ctx, cancel := context.WithCancel(r.Context())
	stop := context.AfterFunc(backend.ctx, cancel)
	p.mu.Unlock()
	defer func() {
		p.mu.Lock()
		backend.conns[conn]--
		if backend.conns[conn] == 0 {
			delete(backend.conns, conn)
		}
		p.mu.Unlock()
		backend.active.Done()
	}()
	defer cancel()
	defer stop()
	backend.proxy.ServeHTTP(w, r.WithContext(ctx))
}

func (p *publicProxy) setBackend(address string) {
	p.clearBackend()
	target := &url.URL{Scheme: "http", Host: address}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	// Requests stay local even when the caller's environment configures a proxy.
	transport.Proxy = nil
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = transport
	proxy.FlushInterval = -1
	ctx, cancel := context.WithCancel(context.Background())
	p.mu.Lock()
	p.backend = &proxyBackend{proxy: proxy, transport: transport, ctx: ctx, cancel: cancel, conns: make(map[net.Conn]int)}
	p.mu.Unlock()
}

func (p *publicProxy) clearBackend() {
	p.mu.Lock()
	old := p.backend
	p.backend = nil
	if old != nil {
		old.cancel()
		old.transport.CloseIdleConnections()
		// Closing downstream sockets unblocks writes even when a client stops reading.
		for conn := range old.conns {
			_ = conn.Close()
		}
	}
	p.mu.Unlock()
	if old != nil {
		drained := make(chan struct{})
		go func() { old.active.Wait(); close(drained) }()
		select {
		case <-drained:
		case <-time.After(5 * time.Second):
			p.t.Fatal("public proxy backend requests did not drain")
		}
	}
}

func TestPublicProxy(t *testing.T) { testPublicProxy(t) }

func testPublicProxy(t *testing.T) {
	t.Helper()
	p := newPublicProxy(t)
	defer p.clearBackend()
	address := strings.TrimPrefix(p.origin, "http://")
	assertOwned := func() {
		t.Helper()
		listener, err := net.Listen("tcp", address)
		if err == nil {
			listener.Close()
			t.Fatal("public listener was released")
		}
	}
	client := &http.Client{Timeout: 3 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	get := func(path string, status int, body string) {
		t.Helper()
		response, err := client.Get(p.origin + path)
		if err != nil {
			t.Fatal(err)
		}
		data, readErr := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		if err := errors.Join(readErr, closeErr); err != nil {
			t.Fatal(err)
		}
		if response.StatusCode != status || (body != "" && string(data) != body) {
			t.Fatalf("%s: status=%d body=%q; want %d %q", path, response.StatusCode, data, status, body)
		}
	}
	assertOwned()
	get("/", http.StatusServiceUnavailable, "")

	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	holdCanceled := make(chan struct{})
	socketEnded := make(chan struct{})
	slowStarted := make(chan struct{})
	slowEnded := make(chan struct{})
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/stream":
			w.Header().Set("Content-Type", "text/event-stream")
			fmt.Fprint(w, "data: first\n\n")
			w.(http.Flusher).Flush()
			select {
			case <-release:
				fmt.Fprint(w, "data: second\n\n")
			case <-r.Context().Done():
			}
		case "/hold":
			fmt.Fprint(w, "ready\n")
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			close(holdCanceled)
		case "/slow":
			defer close(slowEnded)
			chunk := make([]byte, 32<<10)
			for i := 0; i < 4096; i++ {
				if _, err := w.Write(chunk); err != nil {
					return
				}
				if i == 0 {
					close(slowStarted)
				}
			}
		case "/socket":
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				t.Errorf("accept websocket: %v", err)
				return
			}
			defer conn.CloseNow()
			defer close(socketEnded)
			ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
			defer cancel()
			kind, data, err := conn.Read(ctx)
			if err == nil {
				err = conn.Write(ctx, kind, data)
			}
			if err != nil {
				t.Errorf("websocket echo: %v", err)
				return
			}
			_, _, _ = conn.Read(ctx)
		default:
			fmt.Fprintf(w, "first %s", r.Host)
		}
	}))
	t.Cleanup(first.Close)
	p.setBackend(strings.TrimPrefix(first.URL, "http://"))
	assertOwned()
	get("/", http.StatusOK, "first "+address)

	response, err := client.Get(p.origin + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(response.Body)
	line, err := reader.ReadString('\n')
	if err != nil || line != "data: first\n" {
		t.Fatalf("stream first event: %q, %v", line, err)
	}
	releaseOnce.Do(func() { close(release) })
	remaining, err := io.ReadAll(reader)
	if err != nil || string(remaining) != "\ndata: second\n\n" {
		t.Fatalf("stream remainder: %q, %v", remaining, err)
	}
	if err := response.Body.Close(); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, "ws://"+address+"/socket", nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte("hello")); err != nil {
		conn.CloseNow()
		t.Fatal(err)
	}
	kind, data, err := conn.Read(ctx)
	defer conn.CloseNow()
	if err != nil || kind != websocket.MessageText || string(data) != "hello" {
		t.Fatalf("websocket echo: type=%v data=%q error=%v", kind, data, err)
	}

	hold, err := client.Get(p.origin + "/hold")
	if err != nil {
		t.Fatal(err)
	}
	holdReader := bufio.NewReader(hold.Body)
	if line, err := holdReader.ReadString('\n'); err != nil || line != "ready\n" {
		t.Fatalf("held response: %q, %v", line, err)
	}
	slow, err := net.DialTimeout("tcp", address, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer slow.Close()
	if err := slow.(*net.TCPConn).SetReadBuffer(1024); err != nil {
		t.Fatal(err)
	}
	if _, err := fmt.Fprintf(slow, "GET /slow HTTP/1.1\r\nHost: %s\r\n\r\n", address); err != nil {
		t.Fatal(err)
	}
	select {
	case <-slowStarted:
	case <-time.After(3 * time.Second):
		t.Fatal("slow response did not start")
	}
	select {
	case <-slowEnded:
		t.Fatal("slow response finished while its client was not reading")
	case <-time.After(200 * time.Millisecond):
	}
	p.clearBackend()
	assertOwned()
	get("/", http.StatusServiceUnavailable, "")
	select {
	case <-slowEnded:
	case <-time.After(3 * time.Second):
		t.Fatal("slow response did not stop after clearing backend")
	}
	select {
	case <-holdCanceled:
	case <-time.After(3 * time.Second):
		t.Fatal("clearing backend did not cancel its streaming request")
	}
	hold.Body.Close()
	if _, _, err := conn.Read(ctx); err == nil {
		t.Fatal("clearing backend did not close its upgraded connection")
	}
	select {
	case <-socketEnded:
	case <-time.After(3 * time.Second):
		t.Fatal("backend websocket did not exit")
	}
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "second %s", r.Host)
	}))
	t.Cleanup(second.Close)
	p.setBackend(strings.TrimPrefix(second.URL, "http://"))
	assertOwned()
	get("/", http.StatusOK, "second "+address)
}
