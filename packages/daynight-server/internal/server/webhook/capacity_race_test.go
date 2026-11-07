package webhook_test

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	pgwebhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/webhook"
	wm "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
	"github.com/jackc/pgx/v5"
)

type concurrentHTTPResult struct {
	status int
	body   []byte
	err    error
}

func startWebhookCreate(f *httpFixture, actor httpActor, body string) <-chan concurrentHTTPResult {
	result := make(chan concurrentHTTPResult, 1)
	go func() {
		req, err := http.NewRequestWithContext(f.ctx, "POST", f.server.URL+"/api/v1/me/webhooks", strings.NewReader(body))
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

// T01-A11: the first real HTTP create holds its quota locks while its endpoint
// INSERT waits at a test-only advisory gate. The second create must then wait
// behind that first transaction and lose the final protected configuration slot.
func TestHTTPConcurrentLastConfigurationCapacity(t *testing.T) {
	f := newHTTPFixture(t)
	actor := f.actor(t)
	owner := wm.Owner{Kind: "user", ID: actor.id}
	bucket := pgwebhook.Bucket(owner)
	if _, err := f.db.Pool.Exec(f.ctx, `INSERT INTO webhook_quota_owners(owner_kind,owner_id,bucket,records,bytes,active_records,active_bytes) VALUES('user',$1,$2,24573,50325504,24573,50325504)`, actor.id, bucket); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Pool.Exec(f.ctx, `UPDATE webhook_quota_buckets SET records=24573,bytes=50325504,active_records=24573,active_bytes=50325504 WHERE bucket=$1`, bucket); err != nil {
		t.Fatal(err)
	}
	gateHash := sha256.Sum256([]byte(actor.id))
	gate := int64(binary.BigEndian.Uint64(gateHash[:8]))
	ddl := fmt.Sprintf(`CREATE FUNCTION webhook_capacity_gate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(%d); RETURN NEW; END $$; CREATE TRIGGER webhook_capacity_gate BEFORE INSERT ON webhook_endpoints FOR EACH ROW EXECUTE FUNCTION webhook_capacity_gate()`, gate)
	if _, err := f.db.Pool.Exec(f.ctx, ddl); err != nil {
		t.Fatal(err)
	}
	gateConn, err := f.db.Pool.Acquire(f.ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer gateConn.Release()
	if _, err = gateConn.Exec(f.ctx, `SELECT pg_advisory_lock($1)`, gate); err != nil {
		t.Fatal(err)
	}
	released := false
	defer func() {
		if !released {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_, _ = gateConn.Exec(ctx, `SELECT pg_advisory_unlock($1)`, gate)
		}
	}()
	var gatePID int32
	if err = gateConn.QueryRow(f.ctx, `SELECT pg_backend_pid()`).Scan(&gatePID); err != nil {
		t.Fatal(err)
	}
	firstFields := createFields(actor, "first endpoint", "https://first.example/private")
	secondFields := createFields(actor, "second endpoint", "https://second.example/private")
	firstBody, secondBody := encoded(t, firstFields), encoded(t, secondFields)
	first := startWebhookCreate(f, actor, firstBody)
	firstPID := waitWebhookBlocked(t, f, gatePID, "INSERT INTO webhook_endpoints")
	second := startWebhookCreate(f, actor, secondBody)
	secondPID := waitWebhookBlocked(t, f, firstPID, "webhook_quota_buckets")
	if secondPID == firstPID {
		t.Fatal("same connection cannot represent the two contenders")
	}
	if _, err = gateConn.Exec(f.ctx, `SELECT pg_advisory_unlock($1)`, gate); err != nil {
		t.Fatal(err)
	}
	released = true
	one, two := <-first, <-second
	if one.err != nil || two.err != nil || one.status != 201 || two.status != 503 {
		t.Fatalf("first status=%d err=%v; second status=%d err=%v body=%s", one.status, one.err, two.status, two.err, two.body)
	}
	var failure struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err = json.Unmarshal(two.body, &failure); err != nil || failure.Error.Code != "webhook_capacity_unavailable" {
		t.Fatalf("capacity response: %s (%v)", two.body, err)
	}
	var endpoints, keys, receipts, firstReceipt, secondReceipt int
	var endpointsUsed, records, bytes, activeRecords, activeBytes, operations int64
	var bucketRecords, bucketBytes, bucketActiveRecords, bucketActiveBytes, bucketOperations, actualCipherBytes int64
	err = f.db.Pool.QueryRow(f.ctx, `SELECT (SELECT count(*) FROM webhook_endpoints WHERE owner_kind='user' AND owner_id=$1), (SELECT count(*) FROM webhook_signing_keys k JOIN webhook_endpoints e ON e.id=k.endpoint_id WHERE e.owner_kind='user' AND e.owner_id=$1), (SELECT count(*) FROM webhook_operations WHERE owner_kind='user' AND owner_id=$1), (SELECT count(*) FROM webhook_operations WHERE owner_kind='user' AND owner_id=$1 AND operation_id=$2), (SELECT count(*) FROM webhook_operations WHERE owner_kind='user' AND owner_id=$1 AND operation_id=$3), (SELECT coalesce(sum(octet_length(e.destination_ciphertext)+octet_length(k.ciphertext)),0) FROM webhook_endpoints e JOIN webhook_signing_keys k ON k.endpoint_id=e.id WHERE e.owner_kind='user' AND e.owner_id=$1)`, actor.id, firstFields["operationId"], secondFields["operationId"]).Scan(&endpoints, &keys, &receipts, &firstReceipt, &secondReceipt, &actualCipherBytes)
	if err != nil || endpoints != 1 || keys != 1 || receipts != 1 || firstReceipt != 1 || secondReceipt != 0 {
		t.Fatalf("partial effect endpoints=%d keys=%d receipts=%d first=%d second=%d err=%v", endpoints, keys, receipts, firstReceipt, secondReceipt, err)
	}
	err = f.db.Pool.QueryRow(f.ctx, `SELECT endpoints,records,bytes,active_records,active_bytes,operations FROM webhook_quota_owners WHERE owner_kind='user' AND owner_id=$1`, actor.id).Scan(&endpointsUsed, &records, &bytes, &activeRecords, &activeBytes, &operations)
	if err != nil || endpointsUsed != 1 || records != 24575 || activeRecords != 24575 || bytes != 50325504+4096+actualCipherBytes || bytes > 50331648 || bytes+4096 <= 50331648 || activeBytes != bytes || operations != 1 {
		t.Fatalf("owner quota: endpoints=%d records=%d bytes=%d active=%d/%d operations=%d err=%v", endpointsUsed, records, bytes, activeRecords, activeBytes, operations, err)
	}
	err = f.db.Pool.QueryRow(f.ctx, `SELECT records,bytes,active_records,active_bytes,operations FROM webhook_quota_buckets WHERE bucket=$1`, bucket).Scan(&bucketRecords, &bucketBytes, &bucketActiveRecords, &bucketActiveBytes, &bucketOperations)
	if err != nil || bucketRecords != records || bucketBytes != bytes || bucketActiveRecords != activeRecords || bucketActiveBytes != activeBytes || bucketOperations != operations {
		t.Fatalf("bucket quota mismatch: %d %d %d %d %d err=%v", bucketRecords, bucketBytes, bucketActiveRecords, bucketActiveBytes, bucketOperations, err)
	}
}
