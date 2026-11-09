//go:build stress || webhooktest

package server

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
)

type webhookApplicationFixture struct {
	t           *testing.T
	cfg         config.Config
	runtime     *Runtime
	cancel      context.CancelFunc
	done        chan error
	user, token string
}

func (f *webhookApplicationFixture) start() {
	f.t.Helper()
	app, err := service.OpenAppWithLogger(context.Background(), f.cfg, testLogger())
	if err != nil {
		f.t.Fatal(err)
	}
	handler, err := New(app, f.cfg, testLogger())
	if err != nil {
		_ = app.Close(context.Background())
		f.t.Fatal(err)
	}
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, f.cfg.ShutdownTimeout, testLogger(), handler, handler.Shutdown, app.CancelWork, app.Drain, app.Close)
	if err != nil {
		_ = handler.Shutdown(context.Background())
		_ = app.Close(context.Background())
		f.t.Fatal(err)
	}
	root, cancel := context.WithCancel(context.Background())
	if err = app.Start(root); err != nil {
		cancel()
		_ = runtime.Close(context.Background())
		f.t.Fatal(err)
	}
	f.runtime, f.cancel, f.done = runtime, cancel, make(chan error, 1)
	go func() { f.done <- runtime.Run(root) }()
}
func (f *webhookApplicationFixture) stop() {
	f.t.Helper()
	if f.cancel == nil {
		return
	}
	f.cancel()
	select {
	case err := <-f.done:
		if err != nil {
			f.t.Errorf("runtime shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		f.t.Error("runtime shutdown timed out")
	}
	f.cancel = nil
}
func (f *webhookApplicationFixture) request(method, path, body string) (int, []byte) {
	f.t.Helper()
	req, err := http.NewRequest(method, "http://"+f.runtime.Address()+path, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: f.token})
	req.Header.Set("Origin", f.cfg.PublicOrigin)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	if path != "/readyz" && (response.Header.Get("Daynight-User-ID") != f.user || response.Header.Get("Cache-Control") != "no-store") {
		f.t.Fatalf("missing authentication headers: %v", response.Header)
	}
	return response.StatusCode, data
}
func (f *webhookApplicationFixture) expect(method, path, body string, status int) []byte {
	f.t.Helper()
	got, data := f.request(method, path, body)
	if got != status {
		f.t.Fatalf("%s %s: got %d want %d: %s", method, path, got, status, data)
	}
	return data
}
