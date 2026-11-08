package httpoutbound

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func limitsTLSClient(server *httptest.Server) *Client {
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	return NewForTesting(netResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
}

func TestExactRequestAndResponseByteLimits(t *testing.T) {
	var requests atomic.Int32
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		b, err := io.ReadAll(r.Body)
		if err != nil || !bytes.Equal(b, bytes.Repeat([]byte("b"), MaxBodyBytes)) {
			t.Errorf("request body bytes=%d error=%v", len(b), err)
		}
		if r.Method != "POST" || r.Header.Get("Webhook-Id") != "sentinel-id" || r.Header.Get("Webhook-Timestamp") != "1793952005" || r.Header.Get("Webhook-Signature") != "sentinel-signature" {
			t.Errorf("outbound headers changed: %s %v", r.Method, r.Header)
		}
		_, _ = w.Write(bytes.Repeat([]byte("x"), MaxResponseBytes))
	}))
	defer receiver.Close()
	client := limitsTLSClient(receiver)
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	target := receiver.URL + "/" + strings.Repeat("a", MaxURLBytes-len(receiver.URL)-1)
	body := bytes.Repeat([]byte("b"), MaxBodyBytes)
	headers := http.Header{"Webhook-Id": {"sentinel-id"}, "Webhook-Timestamp": {"1793952005"}, "Webhook-Signature": {"sentinel-signature"}}
	response, err := client.Do(ctx, target, body, headers)
	if err != nil || response.Status != 200 || response.Truncated || response.ReadError || len(response.Body) != MaxResponseBytes {
		t.Fatalf("exact limits response=%+v error=%v", response, err)
	}
	if _, err = client.Do(ctx, target+"x", body, nil); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("URL overflow=%v", err)
	}
	if _, err = client.Do(ctx, receiver.URL, append(body, 'x'), nil); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("body overflow=%v", err)
	}
	if requests.Load() != 1 {
		t.Fatalf("invalid request reached receiver: count=%d", requests.Load())
	}
}

func TestExactResponseHeaderLimit(t *testing.T) {
	for _, size := range []int{MaxResponseHeaderBytes, MaxResponseHeaderBytes + 1} {
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
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			response, err := limitsTLSClient(receiver).Do(ctx, receiver.URL, nil, nil)
			if size == MaxResponseHeaderBytes {
				if err != nil || response.Status != 200 {
					t.Fatalf("exact header response=%+v error=%v", response, err)
				}
			} else if !errors.Is(err, ErrTransport) {
				t.Fatalf("header overflow response=%+v error=%v", response, err)
			}
		})
	}
}
