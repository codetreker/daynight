package httpoutbound

import (
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
)

type resolverFunc func(context.Context, string, string) ([]netip.Addr, error)

func (f resolverFunc) LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error) {
	return f(ctx, network, host)
}

func TestPublicAddress(t *testing.T) {
	for _, tc := range []struct {
		address string
		allow   bool
	}{
		{"8.8.8.8", true}, {"192.0.0.9", true}, {"192.0.0.8", false}, {"192.0.0.170", false},
		{"10.0.0.1", false}, {"::ffff:10.0.0.1", false}, {"::ffff:8.8.8.8", true},
		{"2001:4860:4860::8888", true}, {"2001:1::1", true}, {"2001::1234", false},
		{"64:ff9b::808:808", false}, {"64:ff9b:1::1", false}, {"2002:808:808::1", false},
		{"4000::1", false}, {"::8.8.8.8", false}, {"2001:db8::1", false}, {"3fff::1", false}, {"ff02::1", false},
	} {
		if got := PublicAddress(netip.MustParseAddr(tc.address)); got != tc.allow {
			t.Errorf("%s: %v", tc.address, got)
		}
	}
}

func TestTLSRequestResolutionAndBounds(t *testing.T) {
	var count atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count.Add(1)
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "https://receiver.test/other", http.StatusFound)
			return
		}
		if r.URL.Path == "/large" {
			_, _ = w.Write([]byte(strings.Repeat("x", MaxResponseBytes+1)))
			return
		}
		w.Header().Set("Retry-After", "30")
		w.WriteHeader(429)
	}))
	defer srv.Close()
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	// The server certificate is valid for example.com and 127.0.0.1, so a custom
	// test server using receiver.test correctly fails hostname verification.
	var calls atomic.Int32
	resolve := resolverFunc(func(_ context.Context, _, _ string) ([]netip.Addr, error) {
		calls.Add(1)
		return []netip.Addr{netip.MustParseAddr("10.0.0.1"), netip.MustParseAddr("127.0.0.1")}, nil
	})
	c := NewForTesting(resolve, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
	port := strings.TrimPrefix(srv.URL, "https://127.0.0.1")
	if _, err := c.Do(context.Background(), "https://receiver.test"+port+"/secret?key=private", nil, nil); !errors.Is(err, ErrTransport) || strings.Contains(err.Error(), "private") {
		t.Fatalf("hostname verification: %v", err)
	}
	// Literal IP avoids DNS and uses the certificate's actual IP SAN.
	c = NewForTesting(resolve, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
	resp, err := c.Do(context.Background(), srv.URL+"/large", nil, nil)
	if err != nil || resp.Status != 200 || !resp.Truncated || len(resp.Body) != MaxResponseBytes {
		t.Fatalf("large: %+v %v", resp, err)
	}
	resp, err = c.Do(context.Background(), srv.URL+"/redirect", nil, nil)
	if err != nil || resp.Status != 302 || count.Load() != 2 {
		t.Fatalf("redirect: %+v %v count %d", resp, err, count.Load())
	}
	resp, err = c.Do(context.Background(), srv.URL+"/", nil, nil)
	if err != nil || resp.Status != 429 || resp.RetryAfter != "30" {
		t.Fatalf("retry: %+v %v", resp, err)
	}
	if calls.Load() != 1 {
		t.Fatalf("resolver calls %d", calls.Load())
	}
	if _, err := New().Do(context.Background(), srv.URL, nil, nil); !errors.Is(err, ErrTransport) {
		t.Fatalf("loopback admitted: %v", err)
	}
}

func TestInvalidRequestsAndHeaderLimit(t *testing.T) {
	for _, target := range []string{"http://example.test/", "https://user@example.test/", "https://example.test/#x", "https://example.test/?bad=%xx", "https://example.test/" + strings.Repeat("a", MaxURLBytes)} {
		if _, err := New().Do(context.Background(), target, nil, nil); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("target accepted: %v", err)
		}
	}
	if _, err := New().Do(context.Background(), "https://example.test", make([]byte, MaxBodyBytes+1), nil); !errors.Is(err, ErrInvalidRequest) {
		t.Fatal(err)
	}
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Large", strings.Repeat("a", MaxResponseHeaderBytes))
		_, _ = io.WriteString(w, "ok")
	}))
	defer srv.Close()
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	c := NewForTesting(netResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
	if _, err := c.Do(context.Background(), srv.URL, nil, nil); !errors.Is(err, ErrTransport) {
		t.Fatalf("oversized headers accepted: %v", err)
	}
}

type netResolver struct{}

func (netResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return nil, errors.New("unexpected lookup")
}

func TestDNSRecheckedAndNoProxy(t *testing.T) {
	var requests atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.Host, "example.com:") || r.TLS.ServerName != "example.com" {
			t.Errorf("host/SNI %q %q", r.Host, r.TLS.ServerName)
		}
		requests.Add(1)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	var lookups atomic.Int32
	resolve := resolverFunc(func(_ context.Context, _, _ string) ([]netip.Addr, error) {
		if lookups.Add(1) == 1 {
			return []netip.Addr{netip.MustParseAddr("10.0.0.1"), netip.MustParseAddr("127.0.0.1")}, nil
		}
		return []netip.Addr{netip.MustParseAddr("10.0.0.1")}, nil
	})
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	c := NewForTesting(resolve, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
	port := strings.TrimPrefix(srv.URL, "https://127.0.0.1")
	target := "https://example.com" + port + "/path"
	response, err := c.Do(context.Background(), target, nil, nil)
	if err != nil || response.Status != 202 {
		t.Fatalf("first request: %+v %v", response, err)
	}
	if _, err = c.Do(context.Background(), target, nil, nil); !errors.Is(err, ErrTransport) {
		t.Fatalf("changed DNS: %v", err)
	}
	if lookups.Load() != 2 || requests.Load() != 1 {
		t.Fatalf("lookups=%d requests=%d", lookups.Load(), requests.Load())
	}
}

func TestAcknowledgementSurvivesIncompleteBody(t *testing.T) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(202)
		_, _ = io.WriteString(w, "partial")
	}))
	defer srv.Close()
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	c := NewForTesting(netResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
	result, err := c.Do(context.Background(), srv.URL, nil, nil)
	if err != nil || result.Status != 202 || !result.ReadError || string(result.Body) != "partial" {
		t.Fatalf("response %+v, %v", result, err)
	}
	untrusted := NewForTesting(netResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, x509.NewCertPool())
	if _, err = untrusted.Do(context.Background(), srv.URL, nil, nil); !errors.Is(err, ErrTransport) {
		t.Fatalf("untrusted CA: %v", err)
	}
}

func TestRegistryIntegrityAndTestDependencies(t *testing.T) {
	for _, data := range []string{
		"header\n\"unterminated",
		"a,b,c,d,e,f,g,h,i,j\nshort,row",
		"a,b,c,d,e,f,g,h,i,j\n,b,c,d,e,f,g,h,i,j",
		"a,b,c,d,e,f,g,h,i,j\nnot-a-prefix,b,c,d,e,f,g,h,i,j",
	} {
		func() {
			defer func() {
				if recover() == nil {
					t.Error("invalid registry accepted")
				}
			}()
			parseRegistries(data)
		}()
	}
	defer func() {
		if recover() == nil {
			t.Error("missing test dependencies accepted")
		}
	}()
	NewForTesting(nil, nil, nil)
}

func TestTransportFailureRetainsCause(t *testing.T) {
	cause := errors.New("test DNS failure")
	resolve := resolverFunc(func(context.Context, string, string) ([]netip.Addr, error) { return nil, cause })
	c := NewForTesting(resolve, func(netip.Addr) bool { return true }, x509.NewCertPool())
	_, err := c.Do(context.Background(), "https://example.com/secret", nil, nil)
	if !errors.Is(err, ErrTransport) || !errors.Is(err, cause) || strings.Contains(err.Error(), "secret") {
		t.Fatalf("transport failure %v", err)
	}
}
