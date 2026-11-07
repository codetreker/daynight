package webhook_test

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	pgwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// A real trigger holds the first write after its reservation while the second
// request waits on the same bucket, proving the final operation slot is atomic.
func TestWebhookHTTPConcurrentLastReceiptSlot(t *testing.T) {
	f := newHTTPFixture(t)
	actor := f.actor(t)
	o := webhook.Owner{Kind: "user", ID: actor.id}
	bucket := pgwebhook.Bucket(o)
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO webhook_quota_owners(owner_kind,owner_id,bucket,operations) VALUES('user',$1,$2,1023)`, actor.id, bucket); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_quota_buckets SET operations=1023 WHERE bucket=$1`, bucket); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `CREATE FUNCTION hold_webhook_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(2910385109); RETURN NEW; END $$; CREATE TRIGGER hold_webhook_insert BEFORE INSERT ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION hold_webhook_insert()`); err != nil {
		t.Fatal(err)
	}
	conn, err := f.db.Pool.Acquire(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(f.ctx, `SELECT pg_advisory_lock(2910385109)`); err != nil {
		t.Fatal(err)
	}
	defer conn.Exec(context.Background(), `SELECT pg_advisory_unlock(2910385109)`)
	type reply struct {
		status int
		body   string
		err    error
	}
	results := make(chan reply, 2)
	send := func(body string) {
		r, err := http.NewRequestWithContext(f.ctx, "POST", f.server.URL+"/api/v1/me/webhooks", strings.NewReader(body))
		if err != nil {
			results <- reply{err: err}
			return
		}
		r.AddCookie(&http.Cookie{Name: "daynight_session", Value: actor.cookie})
		r.Header.Set("Origin", testOrigin)
		r.Header.Set("Content-Type", "application/json")
		resp, err := f.server.Client().Do(r)
		if err != nil {
			results <- reply{err: err}
			return
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		results <- reply{status: resp.StatusCode, body: string(b), err: err}
	}
	go send(encoded(t, createFields(actor, "one", "https://receiver.example/one")))
	waitBlocked := func(want int) {
		t.Helper()
		for i := 0; i < 200; i++ {
			var n int
			if err := f.db.Pool.QueryRow(f.ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0`).Scan(&n); err != nil {
				t.Fatal(err)
			}
			if n >= want {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("fewer than %d waiting transactions", want)
	}
	waitBlocked(1)
	go send(encoded(t, createFields(actor, "two", "https://receiver.example/two")))
	waitBlocked(2)
	if _, err := conn.Exec(f.ctx, `SELECT pg_advisory_unlock(2910385109)`); err != nil {
		t.Fatal(err)
	}
	a, b := <-results, <-results
	if a.err != nil || b.err != nil || !((a.status == 201 && b.status == 429) || (b.status == 201 && a.status == 429)) {
		t.Fatalf("results %#v %#v", a, b)
	}
	var endpoints, receipts, operations int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_id=$1),(SELECT count(*) FROM webhook_operations WHERE owner_id=$1),operations FROM webhook_quota_owners WHERE owner_kind='user' AND owner_id=$1`, actor.id).Scan(&endpoints, &receipts, &operations); err != nil || endpoints != 1 || receipts != 1 || operations != 1024 {
		t.Fatalf("partial effect endpoints=%d receipts=%d operations=%d err=%v", endpoints, receipts, operations, err)
	}
}
