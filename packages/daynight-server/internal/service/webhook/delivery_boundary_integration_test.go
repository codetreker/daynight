package webhook_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
)

func boundaryClient(server *httptest.Server) *httpoutbound.Client {
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	return httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
}

// The receiver independently verifies the published vector and mutations of
// its exact signed bytes, ID and timestamp over a verified TLS connection.
func TestDeliveryVectorReceiverRejectsTampering(t *testing.T) {
	secret, _ := base64.StdEncoding.DecodeString("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
	id := "a0be4d96-fb33-41ba-a7bd-7885c1e94247"
	timestamp := "1793952005"
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			return
		}
		mac := hmac.New(sha256.New, secret)
		fmt.Fprintf(mac, "%s.%s.", r.Header.Get("Webhook-Id"), r.Header.Get("Webhook-Timestamp"))
		mac.Write(b)
		expected := "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))
		if r.Header.Get("Webhook-Id") != id || r.Header.Get("Webhook-Timestamp") != timestamp || !hmac.Equal([]byte(expected), []byte(r.Header.Get("Webhook-Signature"))) {
			w.WriteHeader(401)
			return
		}
		w.WriteHeader(202)
	}))
	defer receiver.Close()
	body, err := os.ReadFile("../../core/webhook/protocol/testdata/event.json")
	if err != nil {
		t.Fatal(err)
	}
	headers, err := protocol.Authenticate(id, body, [][]byte{secret}, time.Unix(1793952005, 0))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name     string
		body     []byte
		mutate   func(http.Header)
		expected int
	}{
		{"published", body, nil, 202},
		{"body", bytes.Replace(body, []byte(`"paused":true`), []byte(`"paused":false`), 1), nil, 401},
		{"type", bytes.Replace(body, []byte("cc.daynight.task.paused.v1"), []byte("cc.daynight.task.created.v1"), 1), nil, 401},
		{"whitespace", append(append([]byte(nil), body...), ' '), nil, 401},
		{"time", body, func(h http.Header) { h.Set("Webhook-Timestamp", "1793952006") }, 401},
		{"identity", body, func(h http.Header) { h.Set("Webhook-Id", "00000000-0000-0000-0000-000000000000") }, 401},
	}
	c := boundaryClient(receiver)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := headers.Clone()
			if tc.mutate != nil {
				tc.mutate(h)
			}
			response, err := c.Do(context.Background(), receiver.URL, tc.body, h)
			if err != nil || response.Status != tc.expected {
				t.Fatalf("status=%d err=%v", response.Status, err)
			}
		})
	}
}

func TestDeliveryExactByteLimits(t *testing.T) {
	requests := make(chan int, 2)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		requests <- len(b)
		_, _ = w.Write(bytes.Repeat([]byte("x"), httpoutbound.MaxResponseBytes))
	}))
	defer receiver.Close()
	c := boundaryClient(receiver)
	target := receiver.URL + "/" + strings.Repeat("a", httpoutbound.MaxURLBytes-len(receiver.URL)-1)
	body := bytes.Repeat([]byte("b"), httpoutbound.MaxBodyBytes)
	response, err := c.Do(context.Background(), target, body, nil)
	if err != nil || response.Status != 200 || response.Truncated || len(response.Body) != httpoutbound.MaxResponseBytes {
		t.Fatalf("exact limits %+v %v", response, err)
	}
	if n := <-requests; n != httpoutbound.MaxBodyBytes {
		t.Fatalf("body bytes %d", n)
	}
	if _, err = c.Do(context.Background(), target+"x", body, nil); err != httpoutbound.ErrInvalidRequest {
		t.Fatalf("URL overflow %v", err)
	}
	if _, err = c.Do(context.Background(), receiver.URL, append(body, 'x'), nil); err != httpoutbound.ErrInvalidRequest {
		t.Fatalf("body overflow %v", err)
	}
}

func TestDeliveryExactResponseHeaderLimit(t *testing.T) {
	for _, size := range []int{httpoutbound.MaxResponseHeaderBytes, httpoutbound.MaxResponseHeaderBytes + 1} {
		t.Run(fmt.Sprint(size), func(t *testing.T) {
			prefix := "HTTP/1.1 200 OK\r\nX-Pad: "
			suffix := "\r\nContent-Length: 0\r\n\r\n"
			wire := prefix + strings.Repeat("a", size-len(prefix)-len(suffix)) + suffix
			receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				conn, rw, err := w.(http.Hijacker).Hijack()
				if err != nil {
					t.Error(err)
					return
				}
				defer conn.Close()
				if _, err = rw.WriteString(wire); err != nil {
					t.Error(err)
					return
				}
				if err = rw.Flush(); err != nil {
					t.Error(err)
				}
			}))
			defer receiver.Close()
			response, err := boundaryClient(receiver).Do(context.Background(), receiver.URL, nil, nil)
			if size == httpoutbound.MaxResponseHeaderBytes {
				if err != nil || response.Status != 200 {
					t.Fatalf("exact header: %+v %v", response, err)
				}
			} else if err == nil {
				t.Fatalf("oversize header accepted: %+v", response)
			}
		})
	}
}
