package httpoutbound

import (
	"context"
	"crypto/x509"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

func TestIdleSwitchingProtocolsClosesConnection(t *testing.T) {
	closed := make(chan error, 1)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		conn, rw, err := w.(http.Hijacker).Hijack()
		if err != nil {
			closed <- err
			return
		}
		defer conn.Close()
		if _, err = rw.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: idle\r\n\r\n"); err != nil {
			closed <- err
			return
		}
		if err = rw.Flush(); err != nil {
			closed <- err
			return
		}
		if err = conn.SetReadDeadline(time.Now().Add(4 * time.Second)); err != nil {
			closed <- err
			return
		}
		_, err = rw.ReadByte()
		closed <- err
	}))
	defer receiver.Close()
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	client := NewForTesting(netResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	type result struct {
		response Response
		err      error
	}
	returned := make(chan result, 1)
	go func() { response, err := client.Do(ctx, receiver.URL, nil, nil); returned <- result{response, err} }()
	select {
	case got := <-returned:
		if got.err != nil || got.response.Status != 101 {
			t.Fatalf("response=%+v err=%v", got.response, got.err)
		}
	case <-time.After(time.Second):
		t.Fatal("idle upgraded connection did not return after cancellation")
	}
	select {
	case err := <-closed:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("upgraded connection not closed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("upgraded connection remained open")
	}
}
