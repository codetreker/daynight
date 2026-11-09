//go:build startupshutdown && webhooktest && stress

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The full app and HTTP server run in a separate test process. A build-tagged
// test transport alone permits loopback TLS and trusts the receiver's CA.
// After a real delivery, its persisted timestamps are shifted eight days to
// make the seven-day GC boundary observable without waiting in real time. This
// deliberately altered fixture proves the log chain, not original timekeeping.
func TestWebhookAppEventLogThroughGCStress(t *testing.T) {
	received := make(chan []byte, 2)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Error(err)
		}
		received <- body
		w.WriteHeader(http.StatusAccepted)
	}))
	defer receiver.Close()
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: receiver.Certificate().Raw})
	values := processAPIEnvironment(t)
	values["DAYNIGHT_WEBHOOK_ENABLED"] = "1"
	prep := startPersistenceProcess(t, values)
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	db, err := pgx.Connect(ctx, values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(context.Background())
	user, session, team, project, token := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), secret.Random("dnpat_")
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'log-chain',now(),now()+interval '1 day')`, []any{session, user, secret.Hash(token)}},
		{`INSERT INTO teams(id,name) VALUES($1,'logs')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'logs','https://example.test/logs')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err = db.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	client := &http.Client{Timeout: 10 * time.Second}
	defer client.CloseIdleConnections()
	request := func(path string, input any, requestID string, expected int) map[string]any {
		t.Helper()
		body, e := json.Marshal(input)
		if e != nil {
			t.Fatal(e)
		}
		req, e := http.NewRequestWithContext(ctx, "POST", values["DAYNIGHT_PUBLIC_ORIGIN"]+path, bytes.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Origin", values["DAYNIGHT_PUBLIC_ORIGIN"])
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Request-ID", requestID)
		resp, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		data, e := io.ReadAll(resp.Body)
		if e != nil || resp.StatusCode != expected {
			t.Fatalf("request status=%d body=%s err=%v", resp.StatusCode, data, e)
		}
		var out map[string]any
		if e = json.Unmarshal(data, &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	operation := uuid.NewString()
	endpoint := request("/api/v1/me/webhooks", map[string]any{"operationId": operation, "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": user, "name": "log-chain", "enabled": true, "destination": map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": receiver.URL + "/classified-hook"}}, "subscriptions": []any{map[string]any{"id": nil, "projectId": project, "eventTypes": []string{"task.created"}}}}, "endpoint-create", 201)["endpoint"].(map[string]any)["id"].(string)
	var signingSecret []byte
	if err = db.QueryRow(ctx, `SELECT secret FROM webhook_signing_keys WHERE endpoint_id=$1 AND slot='current'`, endpoint).Scan(&signingSecret); err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(signingSecret)
	if err = prep.stop(); err != nil {
		t.Fatal(err)
	}
	// Keep the real GC loop active at its bounded one-second follow-up cadence.
	_, err = db.Exec(ctx, `INSERT INTO webhook_operations (owner_kind,owner_id,operation_id,actor_user_id,endpoint_id,kind,issued_at_lexeme,request_sha256,fingerprint_version,semantic_fingerprint,effect,config_version_after,destination_revision_after,key_id_after,signing_mode_after,overlap_until_after,recorded_at,expires_at)
SELECT owner_kind,owner_id,gen_random_uuid(),actor_user_id,endpoint_id,kind,issued_at_lexeme,request_sha256,fingerprint_version,semantic_fingerprint,effect,config_version_after,destination_revision_after,key_id_after,signing_mode_after,overlap_until_after,now()-interval '31 days',now()-interval '1 day' FROM webhook_operations CROSS JOIN generate_series(1,1500) WHERE operation_id=$1`, operation)
	if err != nil {
		t.Fatal(err)
	}
	child := startControlledWebhookProcess(t, values, ca)
	requestID := "t07-source-chain"
	task := request("/api/v1/projects/"+project+"/tasks", map[string]any{"title": "t07-private-title"}, requestID, 201)
	taskID := task["id"].(string)
	var body []byte
	select {
	case body = <-received:
	case <-ctx.Done():
		t.Fatal("controlled receiver did not get event")
	}
	var wire struct {
		ID string `json:"id"`
	}
	if err = json.Unmarshal(body, &wire); err != nil || wire.ID == "" {
		t.Fatalf("wire event: %v", err)
	}
	var delivery, state string
	var stored []byte
	deadline := time.After(10 * time.Second)
	for {
		err = db.QueryRow(ctx, `SELECT id::text,state,body FROM webhook_deliveries WHERE event_id=$1`, wire.ID).Scan(&delivery, &state, &stored)
		if err == nil && state == "delivered" {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("delivery state=%s err=%v", state, err)
		case <-time.After(20 * time.Millisecond):
		}
	}
	if !bytes.Equal(body, stored) {
		t.Fatal("receiver body differed from persisted bytes")
	}
	var generation, configVersion int64
	if err = db.QueryRow(ctx, `SELECT d.generation,e.config_version FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id WHERE d.id=$1`, delivery).Scan(&generation, &configVersion); err != nil {
		t.Fatal(err)
	}
	manualOperation, manualRequest := uuid.NewString(), "t07-manual-chain"
	request("/api/v1/me/webhooks/"+endpoint+"/deliveries/"+delivery+"/redeliveries", map[string]any{"operationId": manualOperation, "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": user, "ifVersion": fmt.Sprint(configVersion), "ifGeneration": fmt.Sprint(generation)}, manualRequest, 202)
	select {
	case retry := <-received:
		if !bytes.Equal(retry, body) {
			t.Fatal("manual delivery changed body")
		}
	case <-ctx.Done():
		t.Fatal("manual request did not reach controlled receiver")
	}
	deadline = time.After(10 * time.Second)
	for {
		var sequence int
		err = db.QueryRow(ctx, `SELECT state,attempt_sequence FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&state, &sequence)
		if err == nil && state == "delivered" && sequence == 2 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("manual result state=%s sequence=%d err=%v", state, sequence, err)
		case <-time.After(20 * time.Millisecond):
		}
	}
	sum := sha256.Sum256(body)
	// Preserve each relative policy interval while moving this completed row's
	// test chronology backwards. The frozen body is deliberately left intact.
	_, err = db.Exec(ctx, `UPDATE webhook_deliveries SET occurred_at=occurred_at-interval '8 days',automatic_expires_at=automatic_expires_at-interval '8 days',payload_expires_at=payload_expires_at-interval '8 days',automatic_schedule_at=ARRAY(SELECT at-interval '8 days' FROM unnest(automatic_schedule_at) AS at) WHERE id=$1`, delivery)
	if err != nil {
		t.Fatal(err)
	}
	deadline = time.After(25 * time.Second)
	for {
		var removed *time.Time
		if err = db.QueryRow(ctx, `SELECT payload_removed_at FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&removed); err != nil {
			t.Fatal(err)
		}
		if removed != nil && strings.Contains(child.logs.String(), `"phase":"payload"`) {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("real GC did not remove payload/log event: %s", child.logs.String())
		case <-time.After(50 * time.Millisecond):
		}
	}
	if err = child.stop(); err != nil {
		t.Fatal(err)
	}
	logs := child.logs.String()
	for _, forbidden := range []string{token, encoded, receiver.URL, "classified-hook", "t07-private-title", string(body)} {
		if strings.Contains(logs, forbidden) {
			t.Fatalf("sensitive value appeared in stderr")
		}
	}
	phases := map[string]bool{}
	manualPhases := map[string]bool{}
	manualPosted := false
	source := false
	scanner := bufio.NewScanner(strings.NewReader(logs))
	for scanner.Scan() {
		line := scanner.Bytes()
		if !bytes.HasPrefix(line, []byte("{")) {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal(line, &entry); err != nil {
			t.Fatal(err)
		}
		if entry["type"] == "http_request" && entry["request_id"] == requestID && entry["status"] == float64(201) {
			source = true
		}
		if entry["phase"] == "delivery.redeliver" && entry["operation_id"] == manualOperation && entry["request_id"] == manualRequest && entry["endpoint_id"] == endpoint && entry["delivery_id"] == delivery {
			manualPosted = true
		}
		if entry["event_id"] != wire.ID {
			continue
		}
		phase, _ := entry["phase"].(string)
		// Event-level fact GC has an Event ID but intentionally no Delivery.
		if phase == "fact" || phase == "orphan" {
			continue
		}
		if entry["delivery_id"] != delivery || entry["endpoint_id"] != endpoint || entry["owner_id"] != user || entry["project_id"] != project {
			t.Fatalf("bad correlation for %s: %v", phase, entry)
		}
		if phase == "persist" || phase == "admitted" || phase == "http" || phase == "finalize" || phase == "finished" {
			if entry["origin_request_id"] != requestID {
				t.Fatalf("lost origin request in %s", phase)
			}
		}
		if phase == "finalize" && (entry["outcome"] != "acknowledged" || entry["http_status"] != float64(202)) {
			t.Fatalf("invalid final result: %v", entry)
		}
		if phase == "payload" && entry["confirmed_rows"] != float64(1) {
			t.Fatalf("GC count: %v", entry)
		}
		if entry["trigger"] == "manual" && (phase == "claim" || phase == "admitted" || phase == "http" || phase == "finalize" || phase == "finished") {
			if entry["operation_id"] != manualOperation {
				t.Fatalf("manual operation correlation: %v", entry)
			}
			manualPhases[phase] = true
		}
		phases[phase] = true
	}
	if err = scanner.Err(); err != nil {
		t.Fatal(err)
	}
	if !source {
		t.Fatal("source HTTP request not correlated")
	}
	if !manualPosted {
		t.Fatal("manual HTTP operation not correlated")
	}
	for _, phase := range []string{"claim", "admitted", "http", "finalize"} {
		if !manualPhases[phase] {
			t.Fatalf("missing manual phase %s", phase)
		}
	}
	for _, phase := range []string{"persist", "claim", "admitted", "http", "finalize", "payload"} {
		if !phases[phase] {
			t.Fatalf("missing phase %s", phase)
		}
	}
	t.Logf("source_task=%s request=%s event=%s delivery=%s endpoint=%s owner=%s project=%s manual_request=%s operation=%s body_sha256=%x phases=source,persist,claim,admitted,http,finalize,payload manual_phases=redeliver,claim,admitted,http,finalize receiver=202 gc_rows=1 fixture_shift=8d", taskID, requestID, wire.ID, delivery, endpoint, user, project, manualRequest, manualOperation, sum)
}
