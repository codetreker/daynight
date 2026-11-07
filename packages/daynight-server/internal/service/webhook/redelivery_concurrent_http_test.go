package webhook_test

import (
	"net/http"
	"strings"
	"testing"
)

func TestRedeliveryHTTPConcurrentIntents(t *testing.T) {
	r := newRetentionHTTP(t, false)
	var before int64
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT queue_order FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&before); err != nil {
		t.Fatal(err)
	}
	first, second := r.call(http.MethodPost, "/redeliveries", r.intent()), r.call(http.MethodPost, "/redeliveries", r.intent())
	a, b := <-first, <-second
	if a.err != nil || b.err != nil {
		t.Fatalf("request errors: %v %v", a.err, b.err)
	}
	accepted, conflict := 0, 0
	for _, v := range []retentionReply{a, b} {
		if v.status == 202 {
			accepted++
		} else if v.status == 409 && (strings.Contains(v.body, `"generation_conflict"`) || strings.Contains(v.body, `"delivery_busy"`)) {
			conflict++
		} else {
			t.Fatalf("unexpected response %d %s", v.status, v.body)
		}
	}
	if accepted != 1 || conflict != 1 {
		t.Fatalf("accepted=%d conflict=%d", accepted, conflict)
	}
	retentionCounts(t, r, 1, 1, 2)
	var after int64
	if err := r.f.db.Pool.QueryRow(r.f.ctx, `SELECT queue_order FROM webhook_deliveries WHERE id=$1`, r.delivery).Scan(&after); err != nil || after <= before {
		t.Fatalf("tickets before=%d after=%d err=%v", before, after, err)
	}
}
