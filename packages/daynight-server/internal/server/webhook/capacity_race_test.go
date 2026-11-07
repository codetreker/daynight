package webhook_test

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type concurrentHTTPResult struct {
	status int
	body   []byte
	err    error
}

func startWebhookPatch(f *httpFixture, actor httpActor, path, body string) <-chan concurrentHTTPResult {
	result := make(chan concurrentHTTPResult, 1)
	go func() {
		req, err := http.NewRequestWithContext(f.ctx, "PATCH", f.server.URL+path, strings.NewReader(body))
		if err != nil {
			result <- concurrentHTTPResult{err: err}
			return
		}
		req.AddCookie(&http.Cookie{Name: "daynight_session", Value: actor.cookie})
		req.Header.Set("Origin", testOrigin)
		req.Header.Set("Content-Type", "application/json")
		resp, err := f.server.Client().Do(req)
		if err != nil {
			result <- concurrentHTTPResult{err: err}
			return
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		result <- concurrentHTTPResult{status: resp.StatusCode, body: b, err: err}
	}()
	return result
}

func waitWebhookBlocked(t *testing.T, f *httpFixture, blocker int32, fragment string) int32 {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var pid int32
		err := f.db.Pool.QueryRow(f.ctx, `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND position($2 in query)>0 LIMIT 1`, blocker, fragment).Scan(&pid)
		if err == nil {
			return pid
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("inspect blocked queries: %v", err)
		}
		select {
		case <-f.ctx.Done():
			t.Fatalf("no blocked query containing %q: %v", fragment, f.ctx.Err())
		case <-ticker.C:
		}
	}
}

// T01-A11 exercises an actual receipt INSERT failure and a separately ordered
// concurrent CAS. Both requests pass through the production HTTP route.
func TestHTTPReceiptFailureAndConcurrentCAS(t *testing.T) {
	f := newHTTPFixture(t)
	actor := f.actor(t)
	base := "/api/v1/me/webhooks"
	created := createFields(actor, "original", "https://receiver.example/private")
	status, _, body := f.request(t, actor, "POST", base, encoded(t, created))
	mustStatus(t, status, 201, body)
	id := jsonBody(t, body)["endpoint"].(map[string]any)["id"].(string)
	path := base + "/" + id

	snapshot := func() (string, string, int) {
		t.Helper()
		var endpoint, keys string
		var receipts int
		err := f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT row_to_json(e)::text FROM webhook_endpoints e WHERE e.id=$1), (SELECT coalesce(string_agg(row_to_json(k)::text, ',' ORDER BY k.id),'') FROM webhook_signing_keys k WHERE k.endpoint_id=$1), (SELECT count(*) FROM webhook_operations o WHERE o.endpoint_id=$1)`, id).Scan(&endpoint, &keys, &receipts)
		if err != nil {
			t.Fatal(err)
		}
		return endpoint, keys, receipts
	}
	beforeEndpoint, beforeKeys, beforeReceipts := snapshot()
	failed := operationFields(actor)
	failed["ifVersion"], failed["name"] = "1", "must roll back"
	ddl := fmt.Sprintf(`CREATE FUNCTION reject_webhook_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation_id = '%s'::uuid THEN RAISE EXCEPTION 'injected receipt failure' USING ERRCODE='P1048'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_webhook_receipt BEFORE INSERT ON webhook_operations FOR EACH ROW EXECUTE FUNCTION reject_webhook_receipt()`, failed["operationId"])
	if _, err := f.db.Pool.Exec(f.ctx, ddl); err != nil {
		t.Fatal(err)
	}
	status, _, body = f.request(t, actor, "PATCH", path, encoded(t, failed))
	mustStatus(t, status, http.StatusServiceUnavailable, body)
	if jsonBody(t, body)["error"].(map[string]any)["code"] != "dependency_unavailable" {
		t.Fatalf("SQL failure response: %s", body)
	}
	afterEndpoint, afterKeys, afterReceipts := snapshot()
	if beforeEndpoint != afterEndpoint || beforeKeys != afterKeys || beforeReceipts != afterReceipts {
		t.Fatal("receipt insertion failure changed endpoint, keys, or receipts")
	}
	if _, err := f.db.Pool.Exec(f.ctx, `DROP TRIGGER reject_webhook_receipt ON webhook_operations; DROP FUNCTION reject_webhook_receipt()`); err != nil {
		t.Fatal(err)
	}

	// Hold the first update after it has locked the endpoint so a second
	// request with the same version demonstrably waits on the first.
	const gate int64 = 2910385109
	if _, err := f.db.Pool.Exec(f.ctx, `CREATE FUNCTION hold_webhook_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(2910385109); RETURN NEW; END $$; CREATE TRIGGER hold_webhook_update BEFORE UPDATE ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION hold_webhook_update()`); err != nil {
		t.Fatal(err)
	}
	conn, err := f.db.Pool.Acquire(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	if _, err := conn.Exec(f.ctx, `SELECT pg_advisory_lock($1)`, gate); err != nil {
		t.Fatal(err)
	}
	released := false
	defer func() {
		if !released {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_, _ = conn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, gate)
		}
	}()
	var gatePID int32
	if err := conn.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&gatePID); err != nil {
		t.Fatal(err)
	}
	one, two := operationFields(actor), operationFields(actor)
	one["ifVersion"], one["name"] = "1", "first"
	two["ifVersion"], two["name"] = "1", "second"
	first := startWebhookPatch(f, actor, path, encoded(t, one))
	firstPID := waitWebhookBlocked(t, f, gatePID, "webhook_endpoints")
	second := startWebhookPatch(f, actor, path, encoded(t, two))
	secondPID := waitWebhookBlocked(t, f, firstPID, "webhook_endpoints")
	if firstPID == secondPID {
		t.Fatal("contenders must use distinct database connections")
	}
	if _, err := conn.Exec(f.ctx, `SELECT pg_advisory_unlock($1)`, gate); err != nil {
		t.Fatal(err)
	}
	released = true
	r1, r2 := <-first, <-second
	if r1.err != nil || r2.err != nil || r1.status != http.StatusOK || r2.status != http.StatusConflict {
		t.Fatalf("first=%d %s %v second=%d %s %v", r1.status, r1.body, r1.err, r2.status, r2.body, r2.err)
	}
	if jsonBody(t, r2.body)["error"].(map[string]any)["code"] != "version_conflict" {
		t.Fatalf("second request: %s", r2.body)
	}
	var name string
	var version, receipts, failedReceipts, loserReceipts int
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT e.name,e.config_version,(SELECT count(*) FROM webhook_operations WHERE endpoint_id=e.id),(SELECT count(*) FROM webhook_operations WHERE operation_id=$2),(SELECT count(*) FROM webhook_operations WHERE operation_id=$3) FROM webhook_endpoints e WHERE e.id=$1`, id, failed["operationId"], two["operationId"]).Scan(&name, &version, &receipts, &failedReceipts, &loserReceipts); err != nil || name != "first" || version != 2 || receipts != 2 || failedReceipts != 0 || loserReceipts != 0 {
		t.Fatalf("CAS state name=%q version=%d receipts=%d failed=%d loser=%d err=%v", name, version, receipts, failedReceipts, loserReceipts, err)
	}
}
