//go:build integration

package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testBackendReadiness(t *testing.T) {
	p := newPublicProxy(t)
	entered := make(chan struct{}, 1)
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/readyz" {
			if r.Host != strings.TrimPrefix(p.origin, "http://") {
				http.Error(w, "unexpected host", http.StatusNotFound)
				return
			}
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		fmt.Fprint(w, "ready")
	}))
	t.Cleanup(server.Close)
	process := &serverProcess{exited: make(chan struct{}), logs: &processLog{}}
	fmt.Fprintf(process.logs, "{\"type\":\"lifecycle\",\"component\":\"server\",\"phase\":\"listening\",\"address\":%q}\n", strings.TrimPrefix(server.URL, "http://"))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	client := &http.Client{Timeout: time.Second}
	t.Cleanup(client.CloseIdleConnections)
	done := make(chan struct{})
	go func() {
		defer close(done)
		p.setBackend(waitForBackend(t, ctx, process, client, p.origin))
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("readiness request did not reach backend")
	}
	response, err := client.Get(p.origin + "/")
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, response.Body)
	response.Body.Close()
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("backend routed before readiness: %d", response.StatusCode)
	}
	close(release)
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("backend did not become ready")
	}
	response, err = client.Get(p.origin + "/")
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || response.StatusCode != http.StatusOK || string(body) != "ready" {
		t.Fatalf("ready backend response: status=%d body=%q error=%v", response.StatusCode, body, err)
	}
}
