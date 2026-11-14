//go:build integration

package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
)

// The process uses its production fixed-origin client through a controlled TLS
// proxy. This keeps the complete server, worker and database path in the flow.
func githubIntegrationRemote(t *testing.T) (*githubFixtureConfig, func(string)) {
	t.Helper()
	dir := filepath.Join(integrationRunRoot(t), "github-fixture")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.RemoveAll(dir); err != nil {
			t.Error(err)
		}
	})
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	ca := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "Integration CA"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature}
	caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), DNSNames: []string{"api.github.com"}, NotBefore: ca.NotBefore, NotAfter: ca.NotAfter, KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	leafDER, err := x509.CreateCertificate(rand.Reader, leaf, ca, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	caFile, keyFile := filepath.Join(dir, "ca.pem"), filepath.Join(dir, "app.pem")
	if err := os.WriteFile(caFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)}), 0600); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	title := "Initial PR"
	setTitle := func(v string) { mu.Lock(); title = v; mu.Unlock() }
	remote := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/repos/example/integration/installation":
			fmt.Fprint(w, `{"id":99,"account":{"login":"example"}}`)
		case "/app/installations/99/access_tokens":
			w.WriteHeader(http.StatusCreated)
			fmt.Fprintf(w, `{"token":"test","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
		case "/repos/example/integration":
			fmt.Fprint(w, `{"id":42,"full_name":"example/integration","private":false}`)
		case "/installation/repositories":
			fmt.Fprint(w, `{"repositories":[{"id":42,"full_name":"example/integration","private":false}]}`)
		case "/repos/example/integration/pulls":
			mu.Lock()
			current := title
			mu.Unlock()
			_ = json.NewEncoder(w).Encode([]any{map[string]any{"number": 1, "id": 101, "html_url": "https://github.com/example/integration/pull/1", "title": current, "state": "open", "draft": false, "user": nil, "base": map[string]any{"ref": "main", "repo": map[string]any{"id": 42}}, "head": map[string]any{"ref": "branch", "sha": "abc", "repo": nil}, "created_at": "2026-01-01T00:00:00Z", "updated_at": "2026-01-02T00:00:00Z", "closed_at": nil, "merged_at": nil, "body": "saved"}})
		default:
			http.Error(w, "unexpected GitHub request", http.StatusNotFound)
		}
	}))
	remote.TLS = &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{leafDER}, PrivateKey: key}}}
	remote.StartTLS()
	t.Cleanup(remote.Close)
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodConnect || r.Host != "api.github.com:443" {
			http.Error(w, "unexpected proxy target", http.StatusBadRequest)
			return
		}
		upstream, err := net.DialTimeout("tcp", remote.Listener.Addr().String(), 2*time.Second)
		if err != nil {
			http.Error(w, "upstream unavailable", http.StatusBadGateway)
			return
		}
		client, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			upstream.Close()
			return
		}
		_, _ = buf.WriteString("HTTP/1.1 200 Connection Established\r\n\r\n")
		_ = buf.Flush()
		done := make(chan struct{})
		go func() { _, _ = io.Copy(upstream, buf); _ = upstream.Close(); close(done) }()
		_, _ = io.Copy(client, upstream)
		_ = client.Close()
		<-done
	}))
	t.Cleanup(proxy.Close)
	return &githubFixtureConfig{privateKey: keyFile, caFile: caFile, proxyURL: proxy.URL}, setTitle
}

func TestServerAPIGitHubSyncNormalFlow(t *testing.T) {
	config, change := githubIntegrationRemote(t)
	f := newFixtureConfigured(t, false, config)
	project := createProject(t, f, "GitHub sync")
	base := "/api/v1/projects/" + project.ID
	status := requestJSON[api.GitHubStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
	if status.SyncEnabled || !status.ServiceAvailable {
		t.Fatalf("initial: %+v", status)
	}
	status = requestJSON[api.GitHubStatus](t, f, http.MethodPost, base+"/github/connect", map[string]any{"version": status.Version, "installationId": "99"}, http.StatusOK)
	if status.SyncEnabled || status.Connection != "connected" || status.Poll.NextAttemptAt != nil {
		t.Fatalf("connected: %+v", status)
	}
	status = requestJSON[api.GitHubStatus](t, f, http.MethodPatch, base+"/github/sync", map[string]any{"version": status.Version, "syncEnabled": true}, http.StatusOK)
	if !status.SyncEnabled {
		t.Fatalf("enable: %+v", status)
	}
	waitTitle := func(want string) {
		t.Helper()
		ctx, cancel := context.WithTimeout(f.context, 20*time.Second)
		defer cancel()
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			page := requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests", nil, http.StatusOK)
			current := requestJSON[api.GitHubStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
			if len(page.Items) == 1 && page.Items[0].Title == want && !current.Initializing && current.Poll.LastSuccessAt != nil {
				return
			}
			select {
			case <-ctx.Done():
				t.Fatalf("waiting for %q: page=%+v status=%+v", want, page, current)
			case <-ticker.C:
			}
		}
	}
	waitTitle("Initial PR")
	status = requestJSON[api.GitHubStatus](t, f, http.MethodGet, base+"/github", nil, http.StatusOK)
	status = requestJSON[api.GitHubStatus](t, f, http.MethodPatch, base+"/github/sync", map[string]any{"version": status.Version, "syncEnabled": false}, http.StatusOK)
	if status.SyncEnabled || status.Poll.Running || status.Poll.NextAttemptAt != nil {
		t.Fatalf("disable: %+v", status)
	}
	change("Updated while off")
	page := requestJSON[api.PullRequestPage](t, f, http.MethodGet, base+"/pull-requests", nil, http.StatusOK)
	if len(page.Items) != 1 || page.Items[0].Title != "Initial PR" {
		t.Fatalf("retained: %+v", page)
	}
	status = requestJSON[api.GitHubStatus](t, f, http.MethodPatch, base+"/github/sync", map[string]any{"version": status.Version, "syncEnabled": true}, http.StatusOK)
	if !status.SyncEnabled {
		t.Fatalf("re-enable: %+v", status)
	}
	waitTitle("Updated while off")
}
