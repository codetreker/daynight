//go:build webhooktest

package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

// The full app uses real session authentication and PostgreSQL. Only the
// receiver policy, resolver and CA are injected by the webhooktest build.
func TestWebhookProductionManagementRoutes(t *testing.T) {
	received := make(chan []byte, 8)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		received <- data
		w.WriteHeader(http.StatusNoContent)
	}))
	defer receiver.Close()
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	c := configuredTestConfig()
	c.DatabaseURL = testutil.ScopedDatabaseURL(t)
	c.StorageRoot = filepath.Join(testStorageRoot(t), "storage")
	c.ShutdownTimeout = 5 * time.Second
	c.WebhookEnabled = true
	c.WebhookKeyringFile = filepath.Join(filepath.Dir(c.StorageRoot), "keys.json")
	key := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))
	if err := os.WriteFile(c.WebhookKeyringFile, []byte(`{"activeKeyId":"primary","keys":{"primary":"`+key+`"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	db, err := postgres.Open(ctx, c.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	user, session, team, project := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	token := secret.Random("dnst_")
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, secret.Hash(token)}},
		{`INSERT INTO teams(id,name) VALUES($1,'routes')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'routes','https://example.test/routes')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err = db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	f := &webhookApplicationFixture{t: t, cfg: c, user: user, token: token}
	t.Cleanup(f.stop)
	startControlledMaintenanceFixture(f, roots)
	client := &http.Client{Timeout: 5 * time.Second}
	defer client.CloseIdleConnections()
	request := func(method, path string, input any, media, origin string, want int) map[string]any {
		t.Helper()
		var wire []byte
		if input != nil {
			var e error
			wire, e = json.Marshal(input)
			if e != nil {
				t.Fatal(e)
			}
		}
		req, e := http.NewRequestWithContext(ctx, method, "http://"+f.runtime.Address()+path, bytes.NewReader(wire))
		if e != nil {
			t.Fatal(e)
		}
		req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: token})
		req.Header.Set("Origin", origin)
		req.Header.Set("Content-Type", media)
		resp, e := client.Do(req)
		if e != nil {
			t.Fatalf("%s %s: %v", method, path, e)
		}
		defer resp.Body.Close()
		data, e := io.ReadAll(resp.Body)
		if e != nil {
			t.Fatal(e)
		}
		if resp.StatusCode != want {
			t.Fatalf("%s %s status=%d want=%d body=%s", method, path, resp.StatusCode, want, data)
		}
		subject := resp.Header.Get("Daynight-User-ID")
		if resp.Header.Get("Cache-Control") != "no-store" || (origin == c.PublicOrigin && subject != user) || (origin != c.PublicOrigin && subject != "") {
			t.Fatalf("private/auth headers %s %s: %v", method, path, resp.Header)
		}
		kind, _, e := mime.ParseMediaType(resp.Header.Get("Content-Type"))
		if e != nil || kind != "application/json" {
			t.Fatalf("response media %s %s: %s", method, path, resp.Header.Get("Content-Type"))
		}
		var result map[string]any
		if e = json.Unmarshal(data, &result); e != nil {
			t.Fatalf("invalid JSON %s %s: %v", method, path, e)
		}
		return result
	}
	get := func(path string) map[string]any {
		return request("GET", path, nil, "application/json", c.PublicOrigin, 200)
	}
	write := func(method, path string, input any, status int) map[string]any {
		return request(method, path, input, "application/json", c.PublicOrigin, status)
	}
	operation := func() map[string]any {
		return map[string]any{"operationId": uuid.NewString(), "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": user}
	}
	catalog := get("/api/v1/webhook-event-types")
	items := catalog["items"].([]any)
	names := []string{"task.created", "task.status_changed", "task.paused", "task.deleted", "task.step_updated", "task.thread_posted"}
	if len(items) != len(names) {
		t.Fatalf("catalog=%v", catalog)
	}
	for i, name := range names {
		entry := items[i].(map[string]any)
		if entry["key"] != name || entry["wireType"] != "cc.daynight."+name+".v1" || entry["schemaVersion"] != float64(1) {
			t.Fatalf("catalog item=%v", entry)
		}
	}
	settings := catalog["service"].(map[string]any)
	limits := catalog["limits"].(map[string]any)
	if settings["dispatchEnabled"] != true || settings["configurationExpansionAvailable"] != true || limits["policyVersion"] != "1" || limits["requestBytes"] != float64(256<<10) || limits["payloadBytes"] != float64(64<<10) || limits["maxAutomaticAttempts"] != float64(10) {
		t.Fatalf("catalog settings=%v limits=%v", settings, limits)
	}
	bases := []string{"/api/v1/me/webhooks", "/api/v1/teams/" + team + "/webhooks"}
	type endpoint struct {
		base, id, createOperation string
		version                   string
	}
	endpoints := make([]endpoint, 0, 2)
	for _, base := range bases {
		empty := get(base)
		if len(empty["items"].([]any)) != 0 || empty["nextCursor"] != nil {
			t.Fatalf("empty collection=%v", empty)
		}
		creation := operation()
		creation["name"] = "recipient"
		creation["enabled"] = true
		creation["destination"] = map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": receiver.URL}}
		creation["subscriptions"] = []any{map[string]any{"id": nil, "projectId": project, "eventTypes": []string{"task.created"}}}
		result := write("POST", base, creation, 201)
		ep := result["endpoint"].(map[string]any)
		id := ep["id"].(string)
		if ep["configVersion"] != "1" {
			t.Fatalf("create=%v", result)
		}
		summary := get(base)["items"].([]any)[0].(map[string]any)
		if summary["lastAttemptAt"] != nil || summary["lastResult"] != nil {
			t.Fatalf("empty summary=%v", summary)
		}
		path := base + "/" + id
		if get(path)["id"] != id {
			t.Fatal("wrong endpoint")
		}
		if receipt := get(base + "/operations/" + creation["operationId"].(string)); receipt["operationId"] != creation["operationId"] {
			t.Fatalf("receipt=%v", receipt)
		}
		signing := get(path + "/signing-secret")
		if !strings.HasPrefix(signing["secret"].(string), "whsec_") {
			t.Fatalf("secret=%v", signing)
		}
		patch := operation()
		patch["ifVersion"] = "1"
		patch["name"] = "updated"
		if write("PATCH", path, patch, 200)["endpoint"].(map[string]any)["configVersion"] != "2" {
			t.Fatal("patch version")
		}
		rotate := operation()
		rotate["ifVersion"] = "2"
		rotate["mode"] = "immediate"
		rotation := write("POST", path+"/signing-secret/rotations", rotate, 200)
		if rotation["operation"].(map[string]any)["configVersionAfter"] != "3" || rotation["signing"].(map[string]any)["overlapUntil"] != nil {
			t.Fatalf("immediate rotation: %v", rotation)
		}
		replacement := get(path + "/signing-secret")
		if replacement["secret"] == signing["secret"] || replacement["configVersion"] != "3" {
			t.Fatal("signing key did not rotate")
		}
		if get(base + "/operations/" + rotate["operationId"].(string))["operationId"] != rotate["operationId"] {
			t.Fatal("rotation receipt missing")
		}
		endpoints = append(endpoints, endpoint{base: base, id: id, createOperation: creation["operationId"].(string), version: "3"})
	}
	malformed := operation()
	malformed["name"] = "invalid"
	malformed["enabled"] = true
	malformed["destination"] = map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": receiver.URL}}
	malformed["subscriptions"] = []any{}
	invalid := request("POST", bases[0], malformed, "text/plain", c.PublicOrigin, 400)
	if invalid["error"].(map[string]any)["code"] != "invalid_input" {
		t.Fatalf("media error=%v", invalid)
	}
	denied := request("POST", bases[0], malformed, "application/json", "https://other.example", 403)
	if denied["error"].(map[string]any)["code"] != "forbidden" {
		t.Fatalf("origin error=%v", denied)
	}
	task := write("POST", "/api/v1/projects/"+project+"/tasks", map[string]any{"title": "routes source"}, 201)
	taskID := task["id"].(string)
	for range endpoints {
		select {
		case payload := <-received:
			if !bytes.Contains(payload, []byte(taskID)) {
				t.Fatalf("unexpected delivered body: %s", payload)
			}
		case <-ctx.Done():
			t.Fatal("real TLS delivery missing")
		}
	}
	for _, ep := range endpoints {
		path := ep.base + "/" + ep.id
		var delivery, state string
		var generation int64
		var rawBody, rawHash []byte
		for {
			err = db.Pool.QueryRow(ctx, `SELECT id::text,state,generation,body,body_sha256 FROM webhook_deliveries WHERE endpoint_id=$1`, ep.id).Scan(&delivery, &state, &generation, &rawBody, &rawHash)
			if err != nil {
				t.Fatal(err)
			}
			if state == "delivered" {
				break
			}
			select {
			case <-ctx.Done():
				t.Fatalf("delivery not acknowledged: %s", state)
			case <-time.After(20 * time.Millisecond):
			}
		}
		page := get(path + "/deliveries")
		if len(page["items"].([]any)) != 1 || page["nextCursor"] != nil || page["historyMayBeIncomplete"] != true {
			t.Fatalf("deliveries page=%v", page)
		}
		detail := get(path + "/deliveries/" + delivery)
		if detail["id"] != delivery || detail["state"] != "delivered" || detail["generation"] != "1" || detail["nextAttemptAt"] != nil || detail["lastAcknowledgedAt"] == nil {
			t.Fatalf("delivery=%v", detail)
		}
		resource := detail["resource"].(map[string]any)
		if resource["taskId"] != taskID || resource["stepId"] != nil || resource["messageId"] != nil {
			t.Fatalf("resource=%v", resource)
		}
		payload := get(path + "/deliveries/" + delivery + "/payload")
		decoded, e := base64.StdEncoding.DecodeString(payload["body"].(string))
		if e != nil {
			t.Fatal(e)
		}
		digest := sha256.Sum256(rawBody)
		if payload["encoding"] != "base64" || payload["mediaType"] != "application/cloudevents+json" || !bytes.Equal(decoded, rawBody) || !bytes.Equal(digest[:], rawHash) || payload["sha256"] != hex.EncodeToString(digest[:]) || payload["bytes"] != float64(len(rawBody)) {
			t.Fatalf("payload mismatch: %v", payload)
		}
		attempts := get(path + "/deliveries/" + delivery + "/attempts")
		attemptItems := attempts["items"].([]any)
		if len(attemptItems) != 1 || attempts["nextCursor"] != nil {
			t.Fatalf("attempts=%v", attempts)
		}
		a := attemptItems[0].(map[string]any)
		if a["outcome"] != "acknowledged" || a["httpStatus"] != float64(204) || a["error"] != nil || a["lateResult"] != nil || a["generation"] != "1" {
			t.Fatalf("attempt=%v", a)
		}
		summary := get(ep.base)["items"].([]any)[0].(map[string]any)
		if summary["lastAttemptAt"] == nil || summary["lastResult"] == nil {
			t.Fatalf("summary=%v", summary)
		}
		manual := operation()
		manual["ifVersion"] = ep.version
		manual["ifGeneration"] = "1"
		write("POST", path+"/deliveries/"+delivery+"/redeliveries", manual, 202)
		if get(ep.base + "/operations/" + manual["operationId"].(string))["operationId"] != manual["operationId"] {
			t.Fatal("manual receipt missing")
		}
		bad := request("GET", path+"/deliveries/"+delivery+"/attempts?generation=01", nil, "application/json", c.PublicOrigin, 400)
		if bad["error"].(map[string]any)["code"] != "invalid_input" {
			t.Fatalf("generation error=%v", bad)
		}
	}
	// Verify the exact same routes remain mounted while deployment is disabled.
	f.stop()
	f.cfg.WebhookEnabled = false
	startControlledMaintenanceFixture(f, roots)
	disabled := get("/api/v1/webhook-event-types")["service"].(map[string]any)
	if disabled["dispatchEnabled"] != false || disabled["configurationExpansionAvailable"] != false {
		t.Fatalf("disabled catalog=%v", disabled)
	}
	for _, ep := range endpoints {
		path := ep.base + "/" + ep.id
		get(path)
		get(ep.base + "/operations/" + ep.createOperation)
		get(path + "/deliveries")
		remove := operation()
		remove["ifVersion"] = ep.version
		if write("DELETE", path, remove, 200)["endpoint"].(map[string]any)["lifecycle"] != "deleted" {
			t.Fatal("delete did not return tombstone")
		}
		missing := request("GET", path+"/signing-secret", nil, "application/json", c.PublicOrigin, 404)
		if missing["error"].(map[string]any)["code"] != "not_found" {
			t.Fatalf("deleted secret=%v", missing)
		}
	}
	f.stop()
	t.Log("production management routes: personal/team catalog, CRUD, secret/rotation, receipt, deliveries, attempts, payload, manual, errors and disabled deployment")
}
