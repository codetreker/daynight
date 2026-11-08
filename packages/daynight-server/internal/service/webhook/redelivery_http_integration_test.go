package webhook_test

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	taskcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/task"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	webhookhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/webhook"
	identityservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/identity"
	taskservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/task"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestRedeliveryHTTPRealCaptureAndTLS(t *testing.T) {
	requests := make(chan observedRequest, 4)
	var responseStatus atomic.Int64
	responseStatus.Store(http.StatusAccepted)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, e := io.ReadAll(r.Body)
		if e != nil {
			t.Error(e)
		}
		requests <- observedRequest{body: b, id: r.Header.Get("Webhook-Id"), timestamp: r.Header.Get("Webhook-Timestamp"), signature: r.Header.Get("Webhook-Signature")}
		w.WriteHeader(int(responseStatus.Load()))
		_, _ = io.WriteString(w, "receiver-response-body-canary")
	}))
	defer receiver.Close()
	f := newCaptureFixture(t, 1)
	svc := &webhook.Service{DB: f.db, Keys: f.capture.Keys, ConfigurationExpansionAvailable: true, DispatchEnabled: true}
	var endpoint string
	var version int64
	if err := f.db.Pool.QueryRow(f.ctx, `SELECT id::text,config_version FROM webhook_endpoints`).Scan(&endpoint, &version); err != nil {
		t.Fatal(err)
	}
	_, err := svc.Mutate(f.ctx, f.principal, webhook.Owner{Kind: "personal", ID: f.principal.UserID}, webhook.Mutation{Kind: "endpoint.update", EndpointID: endpoint, OperationID: uuid.NewString(), IssuedAt: time.Now().UTC().Format(time.RFC3339Nano), ExpectedUserID: f.principal.UserID, IfVersion: version, RequestSHA256: strings.Repeat("a", 64), Destination: &webhook.Destination{Kind: "http", AdapterVersion: "1", URL: receiver.URL + "/hook"}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = taskservice.NewTasks(f.db, f.capture).Create(f.ctx, f.principal, f.project, taskcore.CreateTask{Title: "redelivery HTTP source"}); err != nil {
		t.Fatal(err)
	}
	var delivery, event string
	var original []byte
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT d.id::text,d.event_id::text,d.body,e.config_version FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id`).Scan(&delivery, &event, &original, &version); err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	runner := webhook.NewRunner(f.db, svc, true)
	runner.SetTestTransport(httpoutbound.NewForTesting(testResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots))
	if err = runner.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if e := runner.Stop(ctx); e != nil {
			t.Error(e)
		}
	})
	receive := func() observedRequest {
		t.Helper()
		select {
		case r := <-requests:
			return r
		case e := <-runner.Failures():
			t.Fatalf("runner: %v", e)
		case <-time.After(10 * time.Second):
			t.Fatal("receiver timeout")
		}
		return observedRequest{}
	}
	first := receive()
	waitState := func(state string, count int) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			var got string
			var n int
			if e := f.db.Pool.QueryRow(f.ctx, `SELECT state,attempt_sequence FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&got, &n); e != nil {
				t.Fatal(e)
			}
			if got == state && n == count {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatalf("state %s sequence %d not observed", state, count)
	}
	waitState("delivered", 1)
	token := secret.Random("dnst_")
	if _, err = f.db.Pool.Exec(f.ctx, `UPDATE sessions SET token_hash=$1 WHERE id=$2`, secret.Hash(token), f.principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewJSONHandler(io.Discard, nil))
	identity := identityservice.New(f.db, nil, "https://daynight.example/auth/callback")
	auth, err := authhttp.NewAuthentication(identity, config.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	webhookhttp.NewRoutes(svc, auth, logger).RegisterRoutes(mux)
	host := httptest.NewServer(mux)
	defer host.Close()
	base := host.URL + "/api/v1/me/webhooks/" + endpoint + "/deliveries/" + delivery
	operation := uuid.NewString()
	body := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":%q,"ifGeneration":"1"}`, operation, time.Now().UTC().Format(time.RFC3339Nano), f.principal.UserID, fmt.Sprint(version))
	call := func(method, path, body string) (int, []byte) {
		t.Helper()
		r, e := http.NewRequestWithContext(f.ctx, method, path, strings.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		r.AddCookie(&http.Cookie{Name: auth.SessionCookieName(), Value: token})
		r.Header.Set("Origin", "https://daynight.example")
		r.Header.Set("Content-Type", "application/json")
		resp, e := host.Client().Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		b, e := io.ReadAll(resp.Body)
		if e != nil {
			t.Fatal(e)
		}
		if resp.Header.Get("Daynight-User-ID") != f.principal.UserID || resp.Header.Get("Cache-Control") != "no-store" {
			t.Fatal(resp.Header)
		}
		return resp.StatusCode, b
	}
	status, b := call("POST", base+"/redeliveries", body)
	if status != 202 {
		t.Fatalf("redelivery %d %s", status, b)
	}
	second := receive()
	waitState("delivered", 2)
	if first.id != event || second.id != event || !bytes.Equal(first.body, original) || !bytes.Equal(second.body, original) || first.signature == "" || second.signature == "" {
		t.Fatal("receiver identity, bytes or signature missing")
	}
	status, b = call("POST", base+"/redeliveries", body)
	if status != 202 {
		t.Fatalf("replay %d %s", status, b)
	}
	var count, manual int
	var generation int64
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT attempt_sequence,manual_operation_count,generation FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&count, &manual, &generation); err != nil {
		t.Fatal(err)
	}
	if count != 2 || manual != 1 || generation != 2 {
		t.Fatalf("sequence=%d manual=%d generation=%d", count, manual, generation)
	}
	responseStatus.Store(http.StatusInternalServerError)
	secondBody := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":%q,"ifGeneration":"2"}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), f.principal.UserID, fmt.Sprint(version))
	status, b = call("POST", base+"/redeliveries", secondBody)
	if status != 202 {
		t.Fatalf("second manual operation %d %s", status, b)
	}
	third := receive()
	waitState("failed", 3)
	if third.id != event || !bytes.Equal(third.body, original) {
		t.Fatal("failed manual attempt changed event or bytes")
	}
	status, b = call("GET", base, "")
	var diagnostic struct {
		LastAcknowledgedAt *time.Time `json:"lastAcknowledgedAt"`
		LastResult         *struct {
			Category string `json:"category"`
		} `json:"lastResult"`
		AutomaticAttemptCount int `json:"automaticAttemptCount"`
		ManualOperationCount  int `json:"manualOperationCount"`
	}
	if status != 200 || json.Unmarshal(b, &diagnostic) != nil || diagnostic.LastAcknowledgedAt == nil || diagnostic.LastResult == nil || diagnostic.LastResult.Category != "http_error" || diagnostic.AutomaticAttemptCount != 1 || diagnostic.ManualOperationCount != 2 {
		t.Fatalf("diagnostic %d %s", status, b)
	}
	responseStatus.Store(http.StatusAccepted)
	thirdBody := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":%q,"ifGeneration":"3"}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), f.principal.UserID, fmt.Sprint(version))
	status, b = call("POST", base+"/redeliveries", thirdBody)
	if status != 202 {
		t.Fatalf("third manual operation %d %s", status, b)
	}
	fourth := receive()
	waitState("delivered", 4)
	if fourth.id != event || !bytes.Equal(fourth.body, original) {
		t.Fatal("third manual attempt changed event or bytes")
	}
	fourthBody := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"ifVersion":%q,"ifGeneration":"4"}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), f.principal.UserID, fmt.Sprint(version))
	status, b = call("POST", base+"/redeliveries", fourthBody)
	if status != 409 {
		t.Fatalf("fourth manual operation %d %s", status, b)
	}
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT attempt_sequence,manual_operation_count,generation FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&count, &manual, &generation); err != nil {
		t.Fatal(err)
	}
	if count != 4 || manual != 3 || generation != 4 {
		t.Fatalf("sequence=%d manual=%d generation=%d", count, manual, generation)
	}
	status, attemptBody := call("GET", base+"/attempts", "")
	if status != 200 || strings.Contains(string(attemptBody), "receiver-response-body-canary") {
		t.Fatalf("receiver response exposed in attempts: %d %s", status, attemptBody)
	}
	var storedAttempts string
	if err = f.db.Pool.QueryRow(f.ctx, `SELECT coalesce(json_agg(a)::text,'[]') FROM webhook_attempts a WHERE delivery_id=$1`, delivery).Scan(&storedAttempts); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(storedAttempts, "receiver-response-body-canary") {
		t.Fatal("receiver response persisted in attempts")
	}
	status, b = call("GET", base+"/payload", "")
	if status != 200 {
		t.Fatalf("payload %d %s", status, b)
	}
	var payload struct {
		Body  []byte `json:"body"`
		Bytes int    `json:"bytes"`
	}
	if err = json.Unmarshal(b, &payload); err != nil || !bytes.Equal(payload.Body, original) || payload.Bytes != len(original) {
		t.Fatalf("payload mismatch: %v", err)
	}
}
