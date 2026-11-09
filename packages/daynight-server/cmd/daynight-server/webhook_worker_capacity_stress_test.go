//go:build startupshutdown && webhooktest && stress

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"encoding/pem"
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

type capacityRequest struct {
	event   string
	release chan struct{}
}

// A real application process runs its eight workers against PostgreSQL. Only the
// test-tagged outbound transport admits loopback and trusts the receiver's CA.
func TestWebhookAppEightWorkersBoundLocalClaimsStress(t *testing.T) {
	arrivals := make(chan capacityRequest, 10)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		request := capacityRequest{event: r.Header.Get("Webhook-Id"), release: make(chan struct{})}
		arrivals <- request
		select {
		case <-request.release:
			w.WriteHeader(http.StatusAccepted)
		case <-r.Context().Done():
		}
	}))
	defer receiver.Close()
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: receiver.Certificate().Raw})
	values := processAPIEnvironment(t)
	values["DAYNIGHT_WEBHOOK_ENABLED"] = "1"
	prep := startPersistenceProcess(t, values)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
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
		{`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'capacity',now(),now()+interval '1 day')`, []any{session, user, secret.Hash(token)}},
		{`INSERT INTO teams(id,name) VALUES($1,'capacity')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'capacity','https://example.test/capacity')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err = db.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	client := &http.Client{Timeout: 10 * time.Second}
	defer client.CloseIdleConnections()
	request := func(path string, input any) map[string]any {
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
		resp, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer resp.Body.Close()
		data, e := io.ReadAll(resp.Body)
		if e != nil || resp.StatusCode != 201 {
			t.Fatalf("request status=%d body=%s err=%v", resp.StatusCode, data, e)
		}
		var out map[string]any
		if e = json.Unmarshal(data, &out); e != nil {
			t.Fatal(e)
		}
		return out
	}
	endpoint := request("/api/v1/me/webhooks", map[string]any{"operationId": uuid.NewString(), "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": user, "name": "capacity", "enabled": true, "destination": map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": receiver.URL + "/capacity"}}, "subscriptions": []any{map[string]any{"id": nil, "projectId": project, "eventTypes": []string{"task.created"}}}})["endpoint"].(map[string]any)["id"].(string)
	if err = prep.stop(); err != nil {
		t.Fatal(err)
	}
	child := startControlledWebhookProcess(t, values, ca)
	var taskIDs []string
	for i := 0; i < 9; i++ {
		out := request("/api/v1/projects/"+project+"/tasks", map[string]any{"title": "worker capacity"})
		taskIDs = append(taskIDs, out["id"].(string))
	}
	var ninthEvent, ninthDelivery string
	if err = db.QueryRow(ctx, `SELECT e.id::text,d.id::text FROM webhook_events e JOIN webhook_deliveries d ON d.event_id=e.id WHERE e.task_id=$1 AND d.endpoint_id=$2`, taskIDs[8], endpoint).Scan(&ninthEvent, &ninthDelivery); err != nil {
		t.Fatal(err)
	}
	active := make([]capacityRequest, 0, 9)
	seen := map[string]bool{}
	for len(active) < 8 {
		select {
		case v := <-arrivals:
			if v.event == "" || v.event == ninthEvent || seen[v.event] {
				t.Fatalf("invalid initial event %s", v.event)
			}
			seen[v.event] = true
			active = append(active, v)
		case <-ctx.Done():
			t.Fatal("eight workers did not reach receiver")
		}
	}
	var state string
	var lease *string
	var attempts, leased int
	if err = db.QueryRow(ctx, `SELECT d.state,d.lease_token::text,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d.id),(SELECT count(*) FROM webhook_deliveries WHERE state='leased') FROM webhook_deliveries d WHERE d.id=$1`, ninthDelivery).Scan(&state, &lease, &attempts, &leased); err != nil {
		t.Fatal(err)
	}
	if state != "pending" || lease != nil || attempts != 0 || leased != 8 {
		t.Fatalf("ninth state=%s lease=%v attempts=%d leased=%d", state, lease, attempts, leased)
	}
	select {
	case v := <-arrivals:
		t.Fatalf("ninth claim before a worker was free: %s", v.event)
	case <-time.After(250 * time.Millisecond):
	}
	close(active[0].release)
	select {
	case v := <-arrivals:
		if v.event != ninthEvent {
			t.Fatalf("expected ninth event %s, got %s", ninthEvent, v.event)
		}
		active = append(active, v)
	case <-ctx.Done():
		t.Fatal("ninth delivery not admitted after worker released")
	}
	if err = db.QueryRow(ctx, `SELECT d.state,d.lease_token::text,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d.id) FROM webhook_deliveries d WHERE d.id=$1`, ninthDelivery).Scan(&state, &lease, &attempts); err != nil {
		t.Fatal(err)
	}
	if state != "leased" || lease == nil || attempts != 1 {
		t.Fatalf("ninth after release state=%s lease=%v attempts=%d", state, lease, attempts)
	}
	for _, v := range active[1:] {
		close(v.release)
	}
	deadline := time.After(8 * time.Second)
	for {
		var delivered, acknowledged int
		if err = db.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_deliveries WHERE state='delivered'),(SELECT count(*) FROM webhook_attempts WHERE outcome='acknowledged')`).Scan(&delivered, &acknowledged); err != nil {
			t.Fatal(err)
		}
		if delivered == 9 && acknowledged == 9 {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("delivered=%d ack=%d", delivered, acknowledged)
		case <-time.After(20 * time.Millisecond):
		}
	}
	if err = child.stop(); err != nil {
		t.Fatal(err)
	}
	// Identifiers are public correlation material; no request payload or token is logged.
	hash := sha256.Sum256([]byte(strings.Join(taskIDs, ",")))
	t.Logf("initial_leases=8 ninth_delivery=%s ninth_event=%s before=pending/zero_attempts after=leased/one_attempt delivered=9 acknowledged=9 task_set_sha256=%x", ninthDelivery, ninthEvent, hash)
}
