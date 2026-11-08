package httpoutbound

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
	"testing"
)

type signedWireResolver struct{}

func (signedWireResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
}

// A fixed published signature lets the receiver validate the transmitted bytes
// independently of the protocol producer, including semantically similar JSON.
func TestSignedWebhookBytesSurviveTLS(t *testing.T) {
	key, err := base64.StdEncoding.DecodeString("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=")
	if err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile("../../core/webhook/protocol/testdata/event.json")
	if err != nil {
		t.Fatal(err)
	}
	const id = "a0be4d96-fb33-41ba-a7bd-7885c1e94247"
	const timestamp = "1793952005"
	headers := http.Header{
		"Webhook-Id":        {id},
		"Webhook-Timestamp": {timestamp},
		"Webhook-Signature": {"v1,SXdZ2STrYaBRe9RlfGMiSwiKRp8Ss/gRz/0aN7Um9tY="},
	}
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mac := hmac.New(sha256.New, key)
		_, _ = fmt.Fprintf(mac, "%s.%s.", r.Header.Get("Webhook-Id"), r.Header.Get("Webhook-Timestamp"))
		_, _ = mac.Write(data)
		expected := "v1," + base64.StdEncoding.EncodeToString(mac.Sum(nil))
		if r.Header.Get("Webhook-Id") != id || r.Header.Get("Webhook-Timestamp") != timestamp || !hmac.Equal([]byte(expected), []byte(r.Header.Get("Webhook-Signature"))) {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(receiver.Close)
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	client := NewForTesting(signedWireResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
	for _, scenario := range []struct {
		name   string
		body   []byte
		mutate func(http.Header)
		status int
	}{
		{"published", body, nil, http.StatusAccepted},
		{"body", bytes.Replace(body, []byte(`"paused":true`), []byte(`"paused":false`), 1), nil, http.StatusUnauthorized},
		{"type", bytes.Replace(body, []byte("cc.daynight.task.paused.v1"), []byte("cc.daynight.task.created.v1"), 1), nil, http.StatusUnauthorized},
		{"whitespace", append(bytes.Clone(body), ' '), nil, http.StatusUnauthorized},
		{"time", body, func(h http.Header) { h.Set("Webhook-Timestamp", "1793952006") }, http.StatusUnauthorized},
		{"identity", body, func(h http.Header) { h.Set("Webhook-Id", "00000000-0000-0000-0000-000000000000") }, http.StatusUnauthorized},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			h := headers.Clone()
			if scenario.mutate != nil {
				scenario.mutate(h)
			}
			response, err := client.Do(t.Context(), receiver.URL, scenario.body, h)
			if err != nil || response.Status != scenario.status {
				t.Fatalf("signed wire response: status=%d error=%v", response.Status, err)
			}
		})
	}
}
