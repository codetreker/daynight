//go:build webhooktest

package server

import (
	"bytes"
	"context"
	"io"
	"mime"
	"strings"
	"testing"
	"time"

	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
)

type maintenanceResolver struct{}

func (maintenanceResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
}
func startControlledMaintenanceFixture(f *webhookApplicationFixture, roots *x509.CertPool) {
	f.t.Helper()
	app, err := service.OpenAppWithLogger(context.Background(), f.cfg, testLogger())
	if err != nil {
		f.t.Fatal(err)
	}
	closeApp := func(cause error) {
		ctx, cancel := context.WithTimeout(context.Background(), f.cfg.Server.ShutdownTimeout)
		defer cancel()
		f.t.Fatalf("composition: %v; cleanup: %v", cause, app.Close(ctx))
	}
	if err = app.SetControlledWebhookTestTransport(httpoutbound.NewForTesting(maintenanceResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)); err != nil {
		closeApp(err)
	}
	handler, err := New(app, f.cfg, testLogger())
	if err != nil {
		closeApp(err)
	}
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, f.cfg.Server.ShutdownTimeout, testLogger(), handler, handler.Shutdown, app.CancelWork, app.Drain, app.Close)
	if err != nil {
		ctx, cancel := context.WithTimeout(context.Background(), f.cfg.Server.ShutdownTimeout)
		defer cancel()
		handler.BeginShutdown()
		if cleanupErr := handler.Shutdown(ctx); cleanupErr != nil {
			f.t.Fatalf("listen: %v; handler cleanup: %v", err, cleanupErr)
		}
		f.t.Fatalf("listen: %v; app cleanup: %v", err, app.Close(ctx))
	}
	root, cancel := context.WithCancel(context.Background())
	if err = app.Start(root); err != nil {
		cancel()
		ctx, stop := context.WithTimeout(context.Background(), f.cfg.Server.ShutdownTimeout)
		defer stop()
		f.t.Fatalf("start: %v; cleanup: %v", err, runtime.Close(ctx))
	}
	f.runtime, f.cancel, f.done = runtime, cancel, make(chan error, 1)
	go func() { f.done <- runtime.Run(root) }()
}

// T07-A03 maintenance/capture/authorization sequence. TLS loopback is allowed
// solely by the webhooktest build's injected resolver, policy and trusted CA.
// This does not claim to cover the separate HTTP/GC lock interleavings.
func TestWebhookProductionMaintenancePauseAndACL(t *testing.T) {
	received := make(chan []byte, 4)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		received <- data
		w.WriteHeader(http.StatusNoContent)
	}))
	defer receiver.Close()
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	c := configuredTestConfig()
	c.Database.URL = testutil.ScopedDatabaseURL(t)
	c.Storage.Root = filepath.Join(testStorageRoot(t), "storage")
	c.Server.ShutdownTimeout = 5 * time.Second
	c.Webhook.Enabled = true
	db, err := postgres.Open(ctx, c.Database.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	owner, admin, ownerSession, adminSession, team, project := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	ownerToken, adminToken := secret.Random("dnst_"), secret.Random("dnst_")
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now()),($2,$2::uuid::text,now(),now())`, []any{owner, admin}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day'),($4,$5,$6,now(),now()+interval '1 day')`, []any{ownerSession, owner, secret.Hash(ownerToken), adminSession, admin, secret.Hash(adminToken)}},
		{`INSERT INTO teams(id,name) VALUES($1,'owner')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, admin}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'maintenance ACL','https://example.test/maintenance-acl')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
		{`INSERT INTO project_grants(project_id,user_id,role) VALUES($1,$2,'member')`, []any{project, owner}},
	} {
		if _, err = db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	f := &webhookApplicationFixture{t: t, cfg: c, user: owner, token: ownerToken}
	t.Cleanup(f.stop)
	body := func(value any) string {
		t.Helper()
		b, e := json.Marshal(value)
		if e != nil {
			t.Fatal(e)
		}
		return string(b)
	}
	operation := func() map[string]any {
		return map[string]any{"operationId": uuid.NewString(), "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": owner}
	}
	startControlledMaintenanceFixture(f, roots)
	create := operation()
	create["name"] = "receiver"
	create["enabled"] = true
	create["destination"] = map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": receiver.URL}}
	create["subscriptions"] = []any{map[string]any{"id": nil, "projectId": project, "eventTypes": []string{"task.created"}}}
	raw := f.expect("POST", "/api/v1/me/webhooks", body(create), 201)
	var created struct {
		Endpoint struct {
			ID string `json:"id"`
		} `json:"endpoint"`
	}
	if err = json.Unmarshal(raw, &created); err != nil || created.Endpoint.ID == "" {
		t.Fatalf("endpoint=%s err=%v", raw, err)
	}
	endpoint := created.Endpoint.ID
	path := "/api/v1/me/webhooks/" + endpoint
	f.stop()
	f.cfg.Webhook.Enabled = false
	startControlledMaintenanceFixture(f, roots)
	asAdmin := func() { f.user, f.token = admin, adminToken }
	asOwner := func() { f.user, f.token = owner, ownerToken }
	task := func(title string) string {
		t.Helper()
		asAdmin()
		result := f.expect("POST", "/api/v1/projects/"+project+"/tasks", body(map[string]any{"title": title}), 201)
		var v struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(result, &v); err != nil || v.ID == "" {
			t.Fatalf("task %s: %v", result, err)
		}
		return v.ID
	}
	count := func(want int) {
		t.Helper()
		var n int
		if err := db.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_deliveries WHERE endpoint_id=$1`, endpoint).Scan(&n); err != nil || n != want {
			t.Fatalf("deliveries=%d want=%d err=%v", n, want, err)
		}
	}
	first := task("captured while maintenance active")
	count(1)
	var grantVersion, epoch int64
	if err = db.Pool.QueryRow(ctx, `SELECT version FROM project_grants WHERE project_id=$1 AND user_id=$2`, project, owner).Scan(&grantVersion); err != nil {
		t.Fatal(err)
	}
	asAdmin()
	f.expect("DELETE", "/api/v1/projects/"+project+"/grants/"+owner, body(map[string]any{"version": grantVersion, "expectedUserId": admin}), 200)
	var authState string
	if err = db.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE endpoint_id=$1 AND project_id=$2 AND deleted_at IS NULL`, endpoint, project).Scan(&authState, &epoch); err != nil || authState != "confirmation_required" || epoch != 2 {
		t.Fatalf("revocation state=%s epoch=%d err=%v", authState, epoch, err)
	}
	revokedTask := task("omitted after access revocation")
	count(1)
	asOwner()
	f.expect("GET", path, "", 200)
	pause := operation()
	pause["ifVersion"] = "1"
	pause["enabled"] = false
	f.expect("PATCH", path, body(pause), 200)
	pausedTask := task("omitted while endpoint paused")
	count(1)
	asOwner()
	enable := operation()
	enable["ifVersion"] = "2"
	enable["enabled"] = true
	rejected := f.expect("PATCH", path, body(enable), 503)
	if !strings.Contains(string(rejected), "webhooks_unavailable") {
		t.Fatalf("enable response: %s", rejected)
	}
	asAdmin()
	invitation := f.expect("POST", "/api/v1/projects/"+project+"/invitations", body(map[string]any{"expectedUserId": admin}), 201)
	var invitationResult struct {
		Link string `json:"link"`
	}
	if err = json.Unmarshal(invitation, &invitationResult); err != nil {
		t.Fatal(err)
	}
	_, invitationToken, ok := strings.Cut(invitationResult.Link, "#")
	if !ok || invitationToken == "" {
		t.Fatalf("invalid invitation link: %s", invitation)
	}
	asOwner()
	f.expect("POST", "/api/v1/invitations/accept", body(map[string]any{"token": invitationToken, "expectedUserId": owner}), 200)
	restoredTask := task("omitted before confirmation")
	count(1)
	asOwner()
	confirm := operation()
	confirm["ifVersion"] = "2"
	confirm["confirmProjectIds"] = []string{project}
	rejected = f.expect("PATCH", path, body(confirm), 503)
	if !strings.Contains(string(rejected), "webhooks_unavailable") {
		t.Fatalf("confirm response: %s", rejected)
	}
	if err = db.Pool.QueryRow(ctx, `SELECT authorization_state,authorization_epoch FROM webhook_subscriptions WHERE endpoint_id=$1 AND project_id=$2 AND deleted_at IS NULL`, endpoint, project).Scan(&authState, &epoch); err != nil || authState != "confirmation_required" || epoch != 2 {
		t.Fatalf("restored grant changed state=%s epoch=%d err=%v", authState, epoch, err)
	}
	var maintenanceState string
	var maintenanceLease *string
	var maintenanceAttempts, rejectedReceipts int
	if err = db.Pool.QueryRow(ctx, `SELECT state,lease_token::text,(SELECT count(*) FROM webhook_attempts WHERE endpoint_id=$1),(SELECT count(*) FROM webhook_operations WHERE operation_id=ANY($2::uuid[])) FROM webhook_deliveries WHERE endpoint_id=$1`, endpoint, []string{enable["operationId"].(string), confirm["operationId"].(string)}).Scan(&maintenanceState, &maintenanceLease, &maintenanceAttempts, &rejectedReceipts); err != nil || maintenanceState != "pending" || maintenanceLease != nil || maintenanceAttempts != 0 || rejectedReceipts != 0 {
		t.Fatalf("maintenance claims or rejected effects: state=%s lease=%v attempts=%d receipts=%d err=%v", maintenanceState, maintenanceLease, maintenanceAttempts, rejectedReceipts, err)
	}
	select {
	case payload := <-received:
		t.Fatalf("maintenance sent a request: %s", payload)
	default:
	}
	f.stop()
	f.cfg.Webhook.Enabled = true
	startControlledMaintenanceFixture(f, roots)
	stillPaused := task("omitted after dispatch resumes but endpoint paused")
	count(1)
	asOwner()
	resume := operation()
	resume["ifVersion"] = "2"
	resume["enabled"] = true
	resume["confirmProjectIds"] = []string{project}
	f.expect("PATCH", path, body(resume), 200)
	final := task("new event after explicit restoration")
	count(2)
	select {
	case payload := <-received:
		if !bytes.Contains(payload, []byte(final)) {
			t.Fatalf("receiver got unexpected event: %s", payload)
		}
	case <-ctx.Done():
		t.Fatal("restored event not received")
	}
	select {
	case payload := <-received:
		t.Fatalf("unexpected historical backfill: %s", payload)
	case <-time.After(1200 * time.Millisecond):
	}
	var events, attempts int
	if err = db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_events WHERE task_id=ANY($1::uuid[])),(SELECT count(*) FROM webhook_attempts WHERE endpoint_id=$2)`, []string{pausedTask, revokedTask, restoredTask, stillPaused}, endpoint).Scan(&events, &attempts); err != nil || events != 0 || attempts != 1 {
		t.Fatalf("unmatched events=%d attempts=%d err=%v", events, attempts, err)
	}
	var firstState string
	if err = db.Pool.QueryRow(ctx, `SELECT state FROM webhook_deliveries WHERE endpoint_id=$1 AND event_id=(SELECT id FROM webhook_events WHERE task_id=$2)`, endpoint, first).Scan(&firstState); err != nil || firstState != "suppressed" {
		t.Fatalf("stale captured obligation state=%s err=%v", firstState, err)
	}
	f.stop()
	t.Log("controlled TLS: maintenance capture=1; pause/revoke/restore skipped 4 tasks; maintenance expansion rejected; explicit confirmation resumed new event; stale authorization suppressed; no backfill")
}

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
	c.Database.URL = testutil.ScopedDatabaseURL(t)
	c.Storage.Root = filepath.Join(testStorageRoot(t), "storage")
	c.Server.ShutdownTimeout = 5 * time.Second
	c.Webhook.Enabled = true
	db, err := postgres.Open(ctx, c.Database.URL)
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
		if resp.Header.Get("Cache-Control") != "no-store" || (origin == c.Server.PublicOrigin && subject != user) || (origin != c.Server.PublicOrigin && subject != "") {
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
		return request("GET", path, nil, "application/json", c.Server.PublicOrigin, 200)
	}
	write := func(method, path string, input any, status int) map[string]any {
		return request(method, path, input, "application/json", c.Server.PublicOrigin, status)
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
	invalid := request("POST", bases[0], malformed, "text/plain", c.Server.PublicOrigin, 400)
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
		bad := request("GET", path+"/deliveries/"+delivery+"/attempts?generation=01", nil, "application/json", c.Server.PublicOrigin, 400)
		if bad["error"].(map[string]any)["code"] != "invalid_input" {
			t.Fatalf("generation error=%v", bad)
		}
	}
	// Verify the exact same routes remain mounted while deployment is disabled.
	f.stop()
	f.cfg.Webhook.Enabled = false
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
		missing := request("GET", path+"/signing-secret", nil, "application/json", c.Server.PublicOrigin, 404)
		if missing["error"].(map[string]any)["code"] != "not_found" {
			t.Fatalf("deleted secret=%v", missing)
		}
	}
	f.stop()
	t.Log("production management routes: personal/team catalog, CRUD, secret/rotation, receipt, deliveries, attempts, payload, manual, errors and disabled deployment")
}
