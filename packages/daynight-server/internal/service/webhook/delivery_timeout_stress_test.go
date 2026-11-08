//go:build stress

package webhook

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

type deadlineResolver struct{ block bool }

func (r deadlineResolver) LookupNetIP(ctx context.Context, _, _ string) ([]netip.Addr, error) {
	if r.block {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
}
func deadlineClient(s *httptest.Server) *httpoutbound.Client {
	roots := x509.NewCertPool()
	roots.AddCert(s.Certificate())
	return httpoutbound.NewForTesting(deadlineResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
}
func assertDuration(t *testing.T, elapsed, lower, upper time.Duration) {
	t.Helper()
	if elapsed < lower || elapsed > upper {
		t.Fatalf("elapsed %v outside [%v,%v]", elapsed, lower, upper)
	}
}

// Real deadlines are tested separately from routine CI because they deliberately
// hold connections until each production timeout has elapsed.
func TestOutboundDeadlineBoundariesStress(t *testing.T) {
	t.Run("dial_and_dns", func(t *testing.T) {
		t.Parallel()
		roots := x509.NewCertPool()
		c := httpoutbound.NewForTesting(deadlineResolver{block: true}, func(netip.Addr) bool { return true }, roots)
		ctx, cancel := context.WithTimeout(context.Background(), 22*time.Second)
		defer cancel()
		start := time.Now()
		_, err := c.Do(ctx, "https://blocked.invalid/", nil, nil)
		elapsed := time.Since(start)
		if err == nil {
			t.Fatal("blocked DNS unexpectedly succeeded")
		}
		assertDuration(t, elapsed, 4500*time.Millisecond, 8*time.Second)
	})
	t.Run("tls_handshake", func(t *testing.T) {
		t.Parallel()
		release := make(chan struct{})
		s := httptest.NewUnstartedServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
		s.TLS = &tls.Config{GetConfigForClient: func(*tls.ClientHelloInfo) (*tls.Config, error) { <-release; return nil, nil }}
		s.StartTLS()
		defer s.Close()
		c := deadlineClient(s)
		ctx, cancel := context.WithTimeout(context.Background(), 22*time.Second)
		defer cancel()
		start := time.Now()
		_, err := c.Do(ctx, s.URL, nil, nil)
		elapsed := time.Since(start)
		close(release)
		if err == nil {
			t.Fatal("stalled TLS unexpectedly succeeded")
		}
		assertDuration(t, elapsed, 4500*time.Millisecond, 8*time.Second)
	})
	t.Run("response_headers", func(t *testing.T) {
		t.Parallel()
		s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { <-r.Context().Done() }))
		defer s.Close()
		c := deadlineClient(s)
		ctx, cancel := context.WithTimeout(context.Background(), 22*time.Second)
		defer cancel()
		start := time.Now()
		_, err := c.Do(ctx, s.URL, nil, nil)
		elapsed := time.Since(start)
		if err == nil {
			t.Fatal("stalled headers unexpectedly succeeded")
		}
		assertDuration(t, elapsed, 9500*time.Millisecond, 13*time.Second)
	})
	t.Run("total_body_after_ack", func(t *testing.T) {
		t.Parallel()
		s := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(http.StatusAccepted)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		}))
		defer s.Close()
		c := deadlineClient(s)
		ctx, cancel := context.WithTimeout(context.Background(), 22*time.Second)
		defer cancel()
		start := time.Now()
		response, err := c.Do(ctx, s.URL, nil, nil)
		elapsed := time.Since(start)
		if err != nil || response.Status != http.StatusAccepted || !response.ReadError {
			t.Fatalf("response=%+v err=%v", response, err)
		}
		assertDuration(t, elapsed, 14500*time.Millisecond, 18*time.Second)
	})
}
