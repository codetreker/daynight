package github

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
)

func TestAppExecutorProductionProviderPollsWithRequestFences(t *testing.T) {
	f := newPollFixture(t)
	var requests atomic.Int32
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		switch r.URL.Path {
		case "/app/installations/20/access_tokens":
			w.WriteHeader(http.StatusCreated)
			fmt.Fprintf(w, `{"token":"installation-token","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
		case "/repos/owner/repo":
			fmt.Fprint(w, `{"id":30,"full_name":"owner/repo","private":true}`)
		case "/repos/owner/repo/pulls":
			fmt.Fprint(w, `[{"number":5,"id":1005,"html_url":"https://github.com/owner/repo/pull/5","title":"Observed PR","user":null,"state":"open","draft":false,"base":{"ref":"main","repo":{"id":30}},"head":{"ref":"topic","sha":"abc","repo":null},"created_at":"2026-01-01T00:00:00Z","updated_at":"2026-01-01T00:00:00Z","body":null,"closed_at":null,"merged_at":null}]`)
		default:
			t.Errorf("unexpected GitHub request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
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
	key := providerKey(t)
	provider, err := NewClientProvider(credentialReaderFunc(func(_ context.Context, app string) (githubpr.CredentialSnapshot, error) {
		if app != executionIdentity.AppResourceID {
			t.Errorf("provider App %q", app)
		}
		return githubpr.CredentialSnapshot{AppResourceID: app, GitHubAppID: executionIdentity.AppID, CredentialVersion: executionIdentity.CredentialVersion, PrivateKeyPEM: key}, nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeProvider(t, provider) })
	e := appExecutor(t, appFixtureStore(t, f), provider)
	if err := e.Execute(context.Background(), testProject); err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 4 || f.renews < int(requests.Load()) {
		t.Fatalf("requests=%d renewals=%d", requests.Load(), f.renews)
	}
	if len(f.publications) != 1 || f.publications[0][0].Number != 5 || f.publications[0][0].SeenPollID == nil || *f.publications[0][0].SeenPollID != f.lease.Token {
		t.Fatalf("poll publication: %+v", f.publications)
	}
	if len(f.runtimes) != 2 || !f.runtimes[1].ReleaseClaim || f.runtimes[1].LastFullSuccessAt == nil {
		t.Fatalf("poll runtime: %+v", f.runtimes)
	}
}
