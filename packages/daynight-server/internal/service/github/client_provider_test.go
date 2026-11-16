package github

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

type credentialReaderFunc func(context.Context, string) (githubpr.CredentialSnapshot, error)

func (f credentialReaderFunc) Credentials(ctx context.Context, id string) (githubpr.CredentialSnapshot, error) {
	return f(ctx, id)
}

func closeProvider(t *testing.T, p *ClientProvider) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := p.Close(ctx); err != nil {
		t.Errorf("provider cleanup: %v", err)
	}
}

func providerKey(t *testing.T) []byte {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
}

func snapshot(id string, version int64, key []byte) githubpr.CredentialSnapshot {
	return githubpr.CredentialSnapshot{AppResourceID: id, GitHubAppID: 42, CredentialVersion: version, PrivateKeyPEM: key}
}

func acquire(t *testing.T, p *ClientProvider, id string, version int64) (func(), interface{}) {
	t.Helper()
	c, release, err := p.Acquire(context.Background(), id, version)
	if err != nil {
		t.Fatal(err)
	}
	return release, c
}

// Exercise the real exported client constructor, TLS transport and token cache.
func TestClientProviderRealTransportAndTokens(t *testing.T) {
	key := providerKey(t)
	var exchanges, rejected atomic.Int32
	closed := make(chan struct{}, 10)
	slowStarted, slowExited := make(chan struct{}), make(chan struct{})
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "api.github.com" {
			t.Errorf("unexpected host %q", r.Host)
		}
		switch r.URL.Path {
		case "/app/installations/12/access_tokens":
			n := exchanges.Add(1)
			w.WriteHeader(http.StatusCreated)
			fmt.Fprintf(w, `{"token":"token-%d","expires_at":%q}`, n, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
		case "/repos/slow/b":
			close(slowStarted)
			<-r.Context().Done()
			close(slowExited)
		case "/repos/a/b":
			if r.Header.Get("Authorization") == "Bearer token-1" && rejected.CompareAndSwap(0, 1) {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer token-") {
				t.Error("missing installation token")
			}
			fmt.Fprint(w, `{"id":7,"full_name":"a/b","private":true}`)
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	srv.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			select {
			case closed <- struct{}{}:
			default:
			}
		}
	}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	transport.Proxy = nil
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if addr != "api.github.com:443" {
			return nil, fmt.Errorf("unexpected target %s", addr)
		}
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = original; transport.CloseIdleConnections() })
	var version atomic.Int64
	version.Store(1)
	reader := credentialReaderFunc(func(_ context.Context, id string) (githubpr.CredentialSnapshot, error) {
		return snapshot(id, version.Load(), key), nil
	})
	p, err := NewClientProvider(reader)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		closeProvider(t, p)
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c1, release1, err := p.Acquire(ctx, "a", 1)
	if err != nil {
		t.Fatal(err)
	}
	defer release1()
	if _, err = c1.Repository(ctx, 12, "a", "b"); err != nil {
		t.Fatal(err)
	}
	if exchanges.Load() != 2 {
		t.Fatalf("401 refresh exchanges=%d", exchanges.Load())
	}
	c1b, release1b, err := p.Acquire(ctx, "a", 1)
	if err != nil || c1b != c1 {
		t.Fatalf("same client %v", err)
	}
	defer release1b()
	if _, err = c1b.Repository(ctx, 12, "a", "b"); err != nil || exchanges.Load() != 2 {
		t.Fatalf("cached token exchanges=%d err=%v", exchanges.Load(), err)
	}
	version.Store(2)
	if _, _, err = p.Acquire(ctx, "a", 1); !errors.Is(err, ErrCredentialChanged) {
		t.Fatalf("old version: %v", err)
	}
	c2, release2, err := p.Acquire(ctx, "a", 2)
	if err != nil || c2 == c1 {
		t.Fatalf("new client: %v", err)
	}
	defer release2()
	if _, err = c2.Repository(ctx, 12, "a", "b"); err != nil || exchanges.Load() != 3 {
		t.Fatalf("version token exchanges=%d err=%v", exchanges.Load(), err)
	}
	other, releaseOther, err := p.Acquire(ctx, "b", 2)
	if err != nil || other == c2 {
		t.Fatalf("other client: %v", err)
	}
	defer releaseOther()
	if _, err = other.Repository(ctx, 12, "a", "b"); err != nil || exchanges.Load() != 4 {
		t.Fatalf("other token exchanges=%d err=%v", exchanges.Load(), err)
	}
	release1()
	release1b()
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("retired client connection did not close")
	}
	release2()
	releaseOther()
	for i := 0; i < 64; i++ {
		r, _ := acquire(t, p, fmt.Sprintf("eviction-%d", i), 2)
		r()
	}
	for i := 0; i < 2; i++ {
		select {
		case <-closed:
		case <-ctx.Done():
			t.Fatal("evicted transport connection did not close")
		}
	}
	active, releaseActive, err := p.Acquire(ctx, "held", 2)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseActive()
	if _, err = active.Repository(ctx, 12, "a", "b"); err != nil {
		t.Fatal(err)
	}
	opCtx, stopOp := context.WithCancel(ctx)
	defer stopOp()
	finished := make(chan error, 1)
	go func() { _, err := active.Repository(opCtx, 12, "slow", "b"); finished <- err }()
	<-slowStarted
	cancelled, stop := context.WithCancel(context.Background())
	stop()
	if err = p.Close(cancelled); !errors.Is(err, context.Canceled) {
		t.Fatalf("close: %v", err)
	}
	if _, err = active.Repository(ctx, 12, "a", "b"); err != nil {
		t.Fatalf("still borrowed transport: %v", err)
	}
	stopOp()
	if err = <-finished; !errors.Is(err, context.Canceled) {
		t.Fatalf("operation cancellation: %v", err)
	}
	<-slowExited
	releaseActive()
	if err = p.Close(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("released transport connection did not close")
	}
}

func TestClientProviderLRUAndBorrowing(t *testing.T) {
	key := providerKey(t)
	p, err := NewClientProvider(credentialReaderFunc(func(_ context.Context, id string) (githubpr.CredentialSnapshot, error) {
		return snapshot(id, 1, key), nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeProvider(t, p)
	release, first := acquire(t, p, "first", 1)
	release()
	for i := 0; i < 63; i++ {
		r, _ := acquire(t, p, fmt.Sprint(i), 1)
		r()
	}
	// Touch the first entry; the next insertion must evict the oldest other one.
	r, touched := acquire(t, p, "first", 1)
	if touched != first {
		t.Fatal("cache miss")
	}
	r()
	r, _ = acquire(t, p, "extra", 1)
	r()
	if p.idle.Len() != 64 {
		t.Fatalf("idle=%d", p.idle.Len())
	}
	if _, ok := p.apps["0"]; ok {
		t.Fatal("least recently used entry retained")
	}
	r, still := acquire(t, p, "first", 1)
	if still != first {
		t.Fatal("recent entry evicted")
	}
	for i := 0; i < 65; i++ {
		r2, _ := acquire(t, p, fmt.Sprintf("new-%d", i), 1)
		r2()
	}
	r2, borrowed := acquire(t, p, "first", 1)
	if borrowed != first {
		t.Fatal("active client evicted")
	}
	r2()
	r()
}

func TestClientProviderConcurrentSnapshotAndDeletion(t *testing.T) {
	key := providerKey(t)
	started, unblock := make(chan struct{}), make(chan struct{})
	var count atomic.Int32
	reader := credentialReaderFunc(func(ctx context.Context, id string) (githubpr.CredentialSnapshot, error) {
		switch count.Add(1) {
		case 1:
			close(started)
			select {
			case <-unblock:
				return snapshot(id, 1, key), nil
			case <-ctx.Done():
				return githubpr.CredentialSnapshot{}, ctx.Err()
			}
		case 2:
			return snapshot(id, 2, key), nil
		default:
			return githubpr.CredentialSnapshot{}, model.ErrNotFound
		}
	})
	p, err := NewClientProvider(reader)
	if err != nil {
		t.Fatal(err)
	}
	defer closeProvider(t, p)
	result := make(chan error, 1)
	go func() {
		_, release, err := p.Acquire(context.Background(), "a", 1)
		if release != nil {
			release()
		}
		result <- err
	}()
	<-started
	r, _ := acquire(t, p, "a", 2)
	close(unblock)
	if err := <-result; !errors.Is(err, ErrCredentialChanged) {
		t.Fatalf("stale read: %v", err)
	}
	if _, _, err := p.Acquire(context.Background(), "a", 2); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deleted: %v", err)
	}
	r()
	r()
	if len(p.apps) != 0 {
		t.Fatal("deleted active client retained after release")
	}
}

func TestClientProviderCloseAndCancel(t *testing.T) {
	key := providerKey(t)
	started, exited := make(chan struct{}), make(chan struct{})
	reader := credentialReaderFunc(func(ctx context.Context, id string) (githubpr.CredentialSnapshot, error) {
		if id == "blocked" {
			close(started)
			<-ctx.Done()
			close(exited)
			return githubpr.CredentialSnapshot{}, ctx.Err()
		}
		return snapshot(id, 1, key), nil
	})
	p, err := NewClientProvider(reader)
	if err != nil {
		t.Fatal(err)
	}
	release, client := acquire(t, p, "active", 1)
	result := make(chan error, 1)
	go func() { _, _, err := p.Acquire(context.Background(), "blocked", 1); result <- err }()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = p.Close(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("close timeout: %v", err)
	}
	<-exited
	if err = <-result; !errors.Is(err, ErrClientProviderClosed) {
		t.Fatalf("read cancellation: %v", err)
	}
	if p.apps["active"].entries[1].client != client {
		t.Fatal("active client destroyed before release")
	}
	if _, _, err = p.Acquire(context.Background(), "active", 1); !errors.Is(err, ErrClientProviderClosed) {
		t.Fatalf("closed acquire: %v", err)
	}
	release()
	closeProvider(t, p)
}

func TestClientProviderConcurrentAcquire(t *testing.T) {
	key := providerKey(t)
	p, err := NewClientProvider(credentialReaderFunc(func(_ context.Context, id string) (githubpr.CredentialSnapshot, error) {
		return snapshot(id, 1, key), nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	defer closeProvider(t, p)
	var wg sync.WaitGroup
	clients := make(chan interface{}, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, r, err := p.Acquire(context.Background(), "same", 1)
			if err != nil {
				t.Error(err)
				return
			}
			clients <- c
			r()
		}()
	}
	wg.Wait()
	close(clients)
	var first interface{}
	for c := range clients {
		if first == nil {
			first = c
		}
		if first != c {
			t.Error("concurrent acquisition made multiple clients")
		}
	}
}

func TestClientProviderDeletionRacesOldSnapshot(t *testing.T) {
	key := providerKey(t)
	started, unblock := make(chan struct{}), make(chan struct{})
	var count atomic.Int32
	reader := credentialReaderFunc(func(ctx context.Context, id string) (githubpr.CredentialSnapshot, error) {
		if count.Add(1) == 1 {
			close(started)
			select {
			case <-unblock:
				return snapshot(id, 1, key), nil
			case <-ctx.Done():
				return githubpr.CredentialSnapshot{}, ctx.Err()
			}
		}
		return githubpr.CredentialSnapshot{}, model.ErrNotFound
	})
	p, err := NewClientProvider(reader)
	if err != nil {
		t.Fatal(err)
	}
	defer closeProvider(t, p)
	result := make(chan error, 1)
	go func() {
		_, release, err := p.Acquire(context.Background(), "a", 1)
		if release != nil {
			release()
		}
		result <- err
	}()
	<-started
	if _, _, err = p.Acquire(context.Background(), "a", 1); !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("deletion: %v", err)
	}
	close(unblock)
	if err = <-result; !errors.Is(err, model.ErrNotFound) {
		t.Fatalf("old snapshot after deletion: %v", err)
	}
	if len(p.apps) != 0 {
		t.Fatal("deleted snapshot retained")
	}
}

func TestClientProviderInputAndReadFailures(t *testing.T) {
	if _, err := NewClientProvider(nil); err == nil {
		t.Fatal("nil reader accepted")
	}
	key := providerKey(t)
	readErr := errors.New("credential read failure")
	reader := credentialReaderFunc(func(_ context.Context, id string) (githubpr.CredentialSnapshot, error) {
		switch id {
		case "failure":
			return githubpr.CredentialSnapshot{}, readErr
		case "wrong-id":
			return snapshot("another", 1, key), nil
		case "zero-version":
			return snapshot(id, 0, key), nil
		case "missing-key":
			return snapshot(id, 1, nil), nil
		case "bad-key":
			return snapshot(id, 1, []byte("not a key")), nil
		default:
			return snapshot(id, 1, key), nil
		}
	})
	p, err := NewClientProvider(reader)
	if err != nil {
		t.Fatal(err)
	}
	defer closeProvider(t, p)
	if err := p.Close(nil); err == nil {
		t.Fatal("nil close context accepted")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, tc := range []struct {
		ctx     context.Context
		id      string
		version int64
	}{
		{nil, "valid", 1}, {context.Background(), "", 1}, {context.Background(), "valid", 0}, {ctx, "valid", 1},
		{context.Background(), "failure", 1}, {context.Background(), "wrong-id", 1}, {context.Background(), "zero-version", 1},
		{context.Background(), "missing-key", 1}, {context.Background(), "bad-key", 1},
	} {
		if _, _, err := p.Acquire(tc.ctx, tc.id, tc.version); err == nil {
			t.Errorf("accepted %q version %d", tc.id, tc.version)
		}
	}
	if _, _, err := p.Acquire(context.Background(), "failure", 1); !errors.Is(err, readErr) {
		t.Fatalf("read error: %v", err)
	}
	if len(p.apps) != 0 {
		t.Fatal("failed acquisition retained app state")
	}
}
