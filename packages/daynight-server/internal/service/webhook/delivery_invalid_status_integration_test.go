package webhook_test

import (
	"net/http"
	"sync/atomic"
	"testing"
	"time"

	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
)

func TestDeliveryInvalidHTTPStatusDoesNotStopRunner(t *testing.T) {
	f := newCaptureFixture(t, 1)
	requests := make(chan string, 2)
	var count atomic.Int32
	svc, client := remainingReceiver(t, f, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- r.Header.Get("Webhook-Id")
		if count.Add(1) == 1 {
			w.WriteHeader(600)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	tasks := taskservice.NewTasks(f.db, f.capture)
	if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "invalid status"}); err != nil {
		t.Fatal(err)
	}
	runner := remainingRunner(t, f, svc, client)
	var first string
	select {
	case first = <-requests:
	case err := <-runner.Failures():
		t.Fatal(err)
	case <-time.After(5 * time.Second):
		t.Fatal("first request missing")
	}
	remainingWait(t, f, runner, func() bool {
		var state string
		var outcome, code *string
		var status *int16
		err := f.db.Pool.QueryRow(f.ctx, `SELECT d.state,a.outcome,a.error_code,a.http_status FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id WHERE d.event_id=$1`, first).Scan(&state, &outcome, &code, &status)
		if err != nil {
			t.Fatal(err)
		}
		return state == "pending" && outcome != nil && *outcome == "transport_error" && code != nil && *code == "invalid_http_status" && status == nil
	})
	if _, err := tasks.Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "subsequent delivery"}); err != nil {
		t.Fatal(err)
	}
	var second string
	select {
	case second = <-requests:
	case err := <-runner.Failures():
		t.Fatalf("runner stopped after invalid status: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("subsequent request missing")
	}
	if second == first {
		t.Fatal("retry arrived before subsequent event")
	}
	remainingWait(t, f, runner, func() bool {
		var state string
		var outcome *string
		var status *int16
		err := f.db.Pool.QueryRow(f.ctx, `SELECT d.state,a.outcome,a.http_status FROM webhook_deliveries d JOIN webhook_attempts a ON a.delivery_id=d.id WHERE d.event_id=$1`, second).Scan(&state, &outcome, &status)
		if err != nil {
			t.Fatal(err)
		}
		return state == "delivered" && outcome != nil && *outcome == "acknowledged" && status != nil && *status == 202
	})
}
