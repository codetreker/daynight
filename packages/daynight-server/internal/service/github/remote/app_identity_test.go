package remote

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestVerifyAppJWTAndIdentity(t *testing.T) {
	var key *rsa.PrivateKey
	c, _, k := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/app" || r.URL.RawQuery != "" || r.Header.Get("Accept") != "application/vnd.github+json" || r.Header.Get("X-GitHub-Api-Version") != apiVersion {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL)
		}
		parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
		if len(parts) != 3 {
			t.Error("missing JWT")
			return
		}
		signature, err := base64.RawURLEncoding.DecodeString(parts[2])
		digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		if err != nil || rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], signature) != nil {
			t.Error("invalid JWT signature")
		}
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		var claims struct {
			Issuer string `json:"iss"`
			Iat    int64  `json:"iat"`
			Exp    int64  `json:"exp"`
		}
		if err != nil || json.Unmarshal(payload, &claims) != nil || claims.Issuer != "42" || claims.Iat > time.Now().Unix()-59 || claims.Exp < time.Now().Unix()+538 {
			t.Error("invalid JWT claims")
		}
		fmt.Fprint(w, `{"id":42,"name":"Example App","slug":"example-app"}`)
	})
	key = k
	identity, err := c.verifyApp(context.Background(), 42)
	if err != nil || identity != (AppIdentity{ID: 42, Name: "Example App", Slug: "example-app"}) {
		t.Fatalf("identity: %+v, %v", identity, err)
	}
}

func TestVerifyAppFailures(t *testing.T) {
	var status atomic.Int32
	var body atomic.Value
	c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(int(status.Load()))
		fmt.Fprint(w, body.Load().(string))
	})
	cases := []struct {
		name    string
		status  int
		body    string
		invalid bool
		code    string
	}{
		{"unauthorized", 401, "secret body", true, ""},
		{"different id", 200, `{"id":43,"name":"app","slug":"app"}`, true, ""},
		{"permission", 403, `{"message":"secret body"}`, false, "permission_denied"},
		{"rate limited", 429, "secret body", false, "rate_limited"},
		{"unavailable", 500, "secret body", false, "unavailable"},
		{"malformed", 200, `{"id":42,"name":"secret body"`, false, ""},
		{"empty", 200, `{"id":42,"name":"","slug":"app"}`, false, ""},
		{"missing slug", 200, `{"id":42,"name":"app"}`, false, ""},
		{"null id", 200, `{"id":null,"name":"app","slug":"app"}`, false, ""},
		{"nul name", 200, `{"id":42,"name":"app\u0000","slug":"app"}`, false, ""},
		{"oversized", 200, strings.Repeat("x", 1024*1024+1), false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status.Store(int32(tc.status))
			body.Store(tc.body)
			identity, err := c.verifyApp(context.Background(), 42)
			if err == nil || errors.Is(err, ErrAppCredentialsInvalid) != tc.invalid || strings.Contains(err.Error(), "secret body") || identity != (AppIdentity{}) {
				t.Fatalf("identity %+v, error %v", identity, err)
			}
			var remoteErr *Error
			if tc.code != "" && (!errors.As(err, &remoteErr) || remoteErr.Code != tc.code) {
				t.Fatalf("upstream classification: %v", err)
			}
		})
	}
	if _, err := VerifyApp(context.Background(), 0, nil); !errors.Is(err, ErrAppCredentialsInvalid) {
		t.Fatalf("invalid input: %v", err)
	}
}

func TestVerifyAppCancellationAndRedirect(t *testing.T) {
	started := make(chan struct{}, 1)
	var foreignCalls atomic.Int32
	foreign := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { foreignCalls.Add(1) }))
	defer foreign.Close()
	var redirect atomic.Bool
	c, _, _ := testClient(t, func(w http.ResponseWriter, r *http.Request) {
		if redirect.Load() {
			http.Redirect(w, r, foreign.URL, http.StatusFound)
			return
		}
		fmt.Fprint(w, `{"id":`)
		w.(http.Flusher).Flush()
		started <- struct{}{}
		<-r.Context().Done()
	})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { _, err := c.verifyApp(ctx, 42); done <- err }()
	<-started
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("request did not cancel")
	}
	redirect.Store(true)
	if _, err := c.verifyApp(context.Background(), 42); err == nil || foreignCalls.Load() != 0 {
		t.Fatalf("redirect err=%v foreign calls=%d", err, foreignCalls.Load())
	}
}

// Verify the exported constructor and fixed origin through a real local TLS
// connection; DialContext prevents the test from contacting GitHub.
func TestVerifyAppPublicFixedOrigin(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Host != "api.github.com" || r.Method != http.MethodGet || r.URL.Path != "/app" || r.URL.RawQuery != "" {
			t.Errorf("unexpected fixed-origin request: host=%q method=%q URL=%q", r.Host, r.Method, r.URL)
		}
		parts := strings.Split(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "), ".")
		if len(parts) != 3 {
			t.Error("missing JWT")
			return
		}
		signature, err := base64.RawURLEncoding.DecodeString(parts[2])
		digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
		if err != nil || rsa.VerifyPKCS1v15(&key.PublicKey, crypto.SHA256, digest[:], signature) != nil {
			t.Error("invalid JWT signature")
		}
		payload, err := base64.RawURLEncoding.DecodeString(parts[1])
		var claims struct {
			Issuer string `json:"iss"`
		}
		if err != nil || json.Unmarshal(payload, &claims) != nil || claims.Issuer != "42" {
			t.Error("incorrect JWT issuer")
		}
		fmt.Fprint(w, `{"id":42,"name":"Example App","slug":"example-app"}`)
	}))
	defer server.Close()
	cert := server.Certificate()
	roots := x509.NewCertPool()
	roots.AddCert(cert)
	serverName := ""
	if len(cert.DNSNames) > 0 {
		serverName = cert.DNSNames[0]
	} else if len(cert.IPAddresses) > 0 {
		serverName = cert.IPAddresses[0].String()
	} else {
		t.Fatal("fixture certificate has no names")
	}
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: serverName, MinVersion: tls.VersionTLS12}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" || address != "api.github.com:443" {
			return nil, fmt.Errorf("unexpected dial target %q %q", network, address)
		}
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	http.DefaultTransport = transport
	defer func() { http.DefaultTransport = original; transport.CloseIdleConnections() }()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	identity, err := VerifyApp(ctx, 42, key)
	if err != nil || identity != (AppIdentity{ID: 42, Name: "Example App", Slug: "example-app"}) || calls.Load() != 1 {
		t.Fatalf("identity=%+v calls=%d err=%v", identity, calls.Load(), err)
	}
	if _, err := VerifyApp(ctx, 42, nil); !errors.Is(err, ErrAppCredentialsInvalid) || calls.Load() != 1 {
		t.Fatalf("invalid key: calls=%d err=%v", calls.Load(), err)
	}
}
