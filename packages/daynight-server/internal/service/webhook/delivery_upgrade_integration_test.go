package webhook_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestDeliveryRunnerStopsAfterIdleUpgrade(t *testing.T) {
	closed := make(chan error, 1)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			closed <- err
			return
		}
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
		if err = conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
			closed <- err
			return
		}
		_, err = rw.ReadByte()
		closed <- err
	}))
	defer receiver.Close()
	f, svc, _ := setupDeliveryReceiver(t, receiver)
	runner := startDeliveryTestRunner(t, f, svc, receiver)
	select {
	case err := <-closed:
		if !errors.Is(err, io.EOF) {
			t.Fatalf("receiver connection did not close: %v", err)
		}
	case err := <-runner.Failures():
		t.Fatalf("runner: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("idle upgraded connection remained open")
	}
	deadline := time.After(3 * time.Second)
	for {
		var outcome *string
		var status *int16
		if err := f.db.Pool.QueryRow(f.ctx, `SELECT outcome,http_status FROM webhook_attempts LIMIT 1`).Scan(&outcome, &status); err != nil {
			t.Fatal(err)
		}
		if outcome != nil {
			if *outcome != "http_error" || status == nil || *status != 101 {
				t.Fatalf("outcome=%v status=%v", outcome, status)
			}
			break
		}
		select {
		case err := <-runner.Failures():
			t.Fatalf("runner: %v", err)
		case <-deadline:
			t.Fatal("response not finalized")
		case <-time.After(20 * time.Millisecond):
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := runner.Stop(ctx); err != nil {
		t.Fatalf("runner did not stop: %v", err)
	}
}
