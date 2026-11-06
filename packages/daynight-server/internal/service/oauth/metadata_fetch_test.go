package oauth

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func metadataFixture(t *testing.T, handler http.Handler) (*MetadataFetcher, *httptest.Server, *atomic.Int32) {
	t.Helper()
	srv := httptest.NewTLSServer(handler)
	t.Cleanup(srv.Close)
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	f := NewMetadataFetcher()
	f.tlsConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	f.lookup = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}
	count := &atomic.Int32{}
	f.dial = func(ctx context.Context, network, addr string) (net.Conn, error) {
		count.Add(1)
		if addr != "8.8.8.8:443" {
			return nil, errors.New("connection was not pinned")
		}
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}
	return f, srv, count
}

func acceptMetadata([]byte) error { return nil }

func TestMetadataAddressAndURLSafety(t *testing.T) {
	for _, tc := range []struct {
		ip     string
		public bool
	}{
		{"8.8.8.8", true}, {"2606:4700:4700::1111", true}, {"::ffff:8.8.8.8", true},
		{"127.0.0.1", false}, {"10.1.2.3", false}, {"100.64.0.1", false}, {"169.254.169.254", false},
		{"192.0.2.1", false}, {"::1", false}, {"fc00::1", false}, {"fe80::1", false},
		{"::ffff:127.0.0.1", false}, {"::ffff:169.254.169.254", false}, {"2001:db8::1", false}, {"ff02::1", false},
	} {
		t.Run(tc.ip, func(t *testing.T) {
			if got := publicMetadataIP(netip.MustParseAddr(tc.ip)); got != tc.public {
				t.Fatalf("publicMetadataIP(%s) = %v", tc.ip, got)
			}
		})
	}
	for _, id := range []string{"http://example.com", "https://user@example.com", "https://example.com/#", "https://[fe80::1%25eth0]/", "https:///path", "https://example.com:bad"} {
		if _, err := metadataURL(id); err == nil {
			t.Errorf("accepted %q", id)
		}
	}
}

func TestMetadataFetchPinsAndCachesValidatedCopies(t *testing.T) {
	f, _, count := metadataFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"client_id":"https://example.com/client"}`)
	}))
	now := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	f.now = func() time.Time { return now }
	id := "https://example.com/client"
	body, deadline, err := f.Fetch(context.Background(), id, acceptMetadata)
	if err != nil || deadline != now.Add(time.Hour) {
		t.Fatalf("fetch: %s %v", deadline, err)
	}
	body[0] = 'x'
	cached, _, err := f.Fetch(context.Background(), id, acceptMetadata)
	if err != nil || cached[0] != '{' || count.Load() != 1 {
		t.Fatalf("cache: %q, %v, dials %d", cached, err, count.Load())
	}
	now = deadline
	if _, _, err := f.Fetch(context.Background(), id, acceptMetadata); err != nil || count.Load() != 2 {
		t.Fatalf("expiration: %v, dials %d", err, count.Load())
	}
}

func TestMetadataFailureIsNotCached(t *testing.T) {
	f, _, count := metadataFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "invalid") }))
	validationError := errors.New("invalid metadata")
	for range 2 {
		if _, _, err := f.Fetch(context.Background(), "https://example.com/client", func([]byte) error { return validationError }); !errors.Is(err, validationError) {
			t.Fatalf("validation: %v", err)
		}
	}
	if count.Load() != 2 {
		t.Fatalf("failed metadata cached: %d dials", count.Load())
	}
	if _, _, err := f.Fetch(context.Background(), "https://example.com/client", acceptMetadata); err != nil {
		t.Fatal(err)
	}
	if _, _, err := f.Fetch(context.Background(), "https://example.com/client", func([]byte) error { return validationError }); !errors.Is(err, validationError) {
		t.Fatal(err)
	}
	if _, _, err := f.Fetch(context.Background(), "https://example.com/client", acceptMetadata); err != nil || count.Load() != 4 {
		t.Fatalf("failed cached validation did not evict: %v, %d", err, count.Load())
	}
}

func TestMetadataFetchRejectsUnsafeDNSRedirectAndOversize(t *testing.T) {
	var calls atomic.Int32
	f, _, dials := metadataFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "https://example.com/destination", http.StatusFound)
			return
		}
		_, _ = io.WriteString(w, strings.Repeat("a", metadataMaxBytes+1))
	}))
	f.lookup = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")}, nil
	}
	if _, _, err := f.Fetch(context.Background(), "https://example.com/unsafe", acceptMetadata); !errors.Is(err, ErrMetadataFetch) || dials.Load() != 0 {
		t.Fatalf("unsafe DNS: %v, %d", err, dials.Load())
	}
	f.lookup = func(context.Context, string) ([]netip.Addr, error) {
		return []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil
	}
	for _, path := range []string{"redirect", "large"} {
		if _, _, err := f.Fetch(context.Background(), "https://example.com/"+path, acceptMetadata); !errors.Is(err, ErrMetadataFetch) {
			t.Fatalf("%s: %v", path, err)
		}
	}
	if calls.Load() != 2 {
		t.Fatalf("redirect was followed: %d", calls.Load())
	}
}

func TestMetadataFetchConcurrentLimitAndCancellation(t *testing.T) {
	entered := make(chan struct{}, 10)
	release := make(chan struct{})
	f, _, _ := metadataFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		entered <- struct{}{}
		<-release
		_, _ = io.WriteString(w, "ok")
	}))
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Go(func() {
			_, _, _ = f.Fetch(context.Background(), fmt.Sprintf("https://example.com/%d", i), acceptMetadata)
		})
	}
	for range 4 {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("requests did not start")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	_, _, err := f.Fetch(ctx, "https://example.com/fifth", acceptMetadata)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("fifth request: %v", err)
	}
	select {
	case <-entered:
		t.Error("fifth request reached server")
	default:
	}
	close(release)
	wg.Wait()
}

func TestMetadataCacheLimit(t *testing.T) {
	f := NewMetadataFetcher()
	deadline := time.Now().Add(time.Hour)
	for i := range metadataMaxCache + 1 {
		f.remember(fmt.Sprint(i), []byte("ok"), deadline)
	}
	if f.lru.Len() != metadataMaxCache {
		t.Fatalf("cache size %d", f.lru.Len())
	}
	if _, _, ok := f.cached("0"); ok {
		t.Fatal("oldest entry retained")
	}
}

func TestMetadataTLSHostnameAndProxyIsolation(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	t.Setenv("https_proxy", "http://127.0.0.1:1")
	f, _, dials := metadataFixture(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	if _, _, err := f.Fetch(context.Background(), "https://example.com/client", acceptMetadata); err != nil {
		t.Fatalf("ambient proxy used: %v", err)
	}
	if _, _, err := f.Fetch(context.Background(), "https://wrong.example/client", acceptMetadata); !errors.Is(err, ErrMetadataFetch) {
		t.Fatalf("wrong TLS hostname: %v", err)
	}
	if dials.Load() != 2 {
		t.Fatalf("dials = %d", dials.Load())
	}
}

func TestMetadataReadLimitAndTimeout(t *testing.T) {
	f, _, count := metadataFixture(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/wait" {
			<-r.Context().Done()
			return
		}
		_, _ = io.WriteString(w, strings.Repeat("a", metadataMaxBytes))
	}))
	body, _, err := f.Fetch(context.Background(), "https://example.com/exact", acceptMetadata)
	if err != nil || len(body) != metadataMaxBytes {
		t.Fatalf("exact limit: %d %v", len(body), err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, _, err := f.Fetch(ctx, "https://example.com/wait", acceptMetadata); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("timeout: %v", err)
	}
	if count.Load() != 2 {
		t.Fatalf("dials = %d", count.Load())
	}
}

func TestMetadataDefaultResolverRejectsLocalhost(t *testing.T) {
	f := NewMetadataFetcher()
	addresses, err := f.lookup(context.Background(), "127.0.0.1")
	if err != nil || len(addresses) != 1 || !addresses[0].IsLoopback() {
		t.Fatalf("literal lookup: %v %v", addresses, err)
	}
	f.lookup = func(context.Context, string) ([]netip.Addr, error) { return addresses, nil }
	var dialed atomic.Bool
	f.dial = func(context.Context, string, string) (net.Conn, error) {
		dialed.Store(true)
		return nil, errors.New("unexpected dial")
	}
	if _, _, err := f.Fetch(context.Background(), "https://localhost/metadata", acceptMetadata); !errors.Is(err, ErrMetadataFetch) {
		t.Fatalf("localhost: %v", err)
	}
	if dialed.Load() {
		t.Fatal("resolved localhost reached dial")
	}
}

func TestMetadataLookupAndDialFailures(t *testing.T) {
	for _, tc := range []struct {
		name   string
		lookup func(context.Context, string) ([]netip.Addr, error)
	}{
		{"failed DNS", func(context.Context, string) ([]netip.Addr, error) { return nil, errors.New("private diagnostic") }},
		{"empty DNS", func(context.Context, string) ([]netip.Addr, error) { return nil, nil }},
		{"failed dial", func(context.Context, string) ([]netip.Addr, error) {
			return []netip.Addr{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("1.1.1.1")}, nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := NewMetadataFetcher()
			f.lookup = tc.lookup
			var attempts atomic.Int32
			f.dial = func(context.Context, string, string) (net.Conn, error) {
				attempts.Add(1)
				return nil, errors.New("private diagnostic")
			}
			for range 2 {
				if _, _, err := f.Fetch(context.Background(), "https://example.com/metadata", acceptMetadata); !errors.Is(err, ErrMetadataFetch) || strings.Contains(err.Error(), "private") {
					t.Fatalf("fetch error: %v", err)
				}
			}
			if tc.name == "failed dial" && attempts.Load() != 4 {
				t.Fatalf("failed addresses not retried safely, attempts: %d", attempts.Load())
			}
		})
	}
}

func TestMetadataUnsafeLiteralNeverDials(t *testing.T) {
	f := NewMetadataFetcher()
	var dialed atomic.Bool
	f.dial = func(context.Context, string, string) (net.Conn, error) {
		dialed.Store(true)
		return nil, errors.New("unexpected dial")
	}
	for _, id := range []string{"https://127.0.0.1/metadata", "https://[::ffff:169.254.169.254]/metadata"} {
		if _, _, err := f.Fetch(context.Background(), id, acceptMetadata); !errors.Is(err, ErrMetadataFetch) {
			t.Fatalf("%s: %v", id, err)
		}
	}
	if dialed.Load() {
		t.Fatal("unsafe literal reached dial")
	}
}

func TestMetadataCacheReplacement(t *testing.T) {
	f := NewMetadataFetcher()
	deadline := time.Now().Add(time.Hour)
	f.remember("same", []byte("old"), deadline)
	f.remember("same", []byte("new"), deadline)
	body, _, ok := f.cached("same")
	if !ok || string(body) != "new" || f.lru.Len() != 1 {
		t.Fatalf("replacement: %q, present %v, entries %d", body, ok, f.lru.Len())
	}
}
