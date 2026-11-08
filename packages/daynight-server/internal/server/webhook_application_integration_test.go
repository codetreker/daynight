package server

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

type webhookApplicationFixture struct {
	t           *testing.T
	cfg         config.Config
	runtime     *Runtime
	cancel      context.CancelFunc
	done        chan error
	user, token string
}

func (f *webhookApplicationFixture) start() {
	f.t.Helper()
	app, err := service.OpenAppWithLogger(context.Background(), f.cfg, testLogger())
	if err != nil {
		f.t.Fatal(err)
	}
	handler, err := New(app, f.cfg, testLogger())
	if err != nil {
		_ = app.Close(context.Background())
		f.t.Fatal(err)
	}
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, f.cfg.ShutdownTimeout, testLogger(), handler, handler.Shutdown, app.CancelWork, app.Drain, app.Close)
	if err != nil {
		_ = handler.Shutdown(context.Background())
		_ = app.Close(context.Background())
		f.t.Fatal(err)
	}
	root, cancel := context.WithCancel(context.Background())
	if err = app.Start(root); err != nil {
		cancel()
		_ = runtime.Close(context.Background())
		f.t.Fatal(err)
	}
	f.runtime, f.cancel, f.done = runtime, cancel, make(chan error, 1)
	go func() { f.done <- runtime.Run(root) }()
}
func (f *webhookApplicationFixture) stop() {
	f.t.Helper()
	if f.cancel == nil {
		return
	}
	f.cancel()
	select {
	case err := <-f.done:
		if err != nil {
			f.t.Errorf("runtime shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		f.t.Error("runtime shutdown timed out")
	}
	f.cancel = nil
}
func (f *webhookApplicationFixture) request(method, path, body string) (int, []byte) {
	f.t.Helper()
	req, err := http.NewRequest(method, "http://"+f.runtime.Address()+path, strings.NewReader(body))
	if err != nil {
		f.t.Fatal(err)
	}
	req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: f.token})
	req.Header.Set("Origin", f.cfg.PublicOrigin)
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		f.t.Fatal(err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(response.Body)
	if err != nil {
		f.t.Fatal(err)
	}
	if path != "/readyz" && (response.Header.Get("Daynight-User-ID") != f.user || response.Header.Get("Cache-Control") != "no-store") {
		f.t.Fatalf("missing authentication headers: %v", response.Header)
	}
	return response.StatusCode, data
}
func (f *webhookApplicationFixture) expect(method, path, body string, status int) []byte {
	f.t.Helper()
	got, data := f.request(method, path, body)
	if got != status {
		f.t.Fatalf("%s %s: got %d want %d: %s", method, path, got, status, data)
	}
	return data
}

// Exercises the actual app, production routes, runtime and PostgreSQL across
// disabled, enabled, and maintenance restarts using a real authenticated HTTP client.
func TestWebhookProductionApplicationMaintenance(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	c := configuredTestConfig()
	c.DatabaseURL = testutil.ScopedDatabaseURL(t)
	c.StorageRoot = filepath.Join(testStorageRoot(t), "storage")
	c.ShutdownTimeout = 5 * time.Second
	db, err := postgres.Open(ctx, c.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(db.Close)
	f := &webhookApplicationFixture{t: t, cfg: c, user: uuid.NewString(), token: secret.Random("dnst_")}
	t.Cleanup(f.stop)
	session, team, project := uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$1::uuid::text,now(),now())`, []any{f.user}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, f.user, secret.Hash(f.token)}},
		{`INSERT INTO teams(id,name) VALUES($1,'maintenance')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, f.user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'maintenance','https://example.test/maintenance')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err := db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	create := func() string {
		data, err := json.Marshal(map[string]any{"operationId": uuid.NewString(), "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": f.user, "name": "receiver", "enabled": true, "destination": map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": "https://receiver.example/hook"}}, "subscriptions": []any{map[string]any{"id": nil, "projectId": project, "eventTypes": []string{"task.created"}}}})
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	f.start()
	f.expect("GET", "/readyz", "", 200)
	catalog := f.expect("GET", "/api/v1/webhook-event-types", "", 200)
	var catalogJSON struct {
		Items   []any `json:"items"`
		Service struct {
			Dispatch bool `json:"dispatchEnabled"`
		} `json:"service"`
	}
	if json.Unmarshal(catalog, &catalogJSON) != nil || len(catalogJSON.Items) != 6 || catalogJSON.Service.Dispatch {
		t.Fatalf("default catalog: %s", catalog)
	}
	empty := f.expect("GET", "/api/v1/me/webhooks", "", 200)
	if !bytes.Contains(empty, []byte(`"items":[]`)) {
		t.Fatalf("empty collection: %s", empty)
	}
	reject := f.expect("POST", "/api/v1/me/webhooks", create(), 503)
	if !bytes.Contains(reject, []byte(`"webhooks_unavailable"`)) {
		t.Fatalf("disabled error: %s", reject)
	}
	var endpoints, receipts int
	if err = db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_endpoints),(SELECT count(*) FROM webhook_operations)`).Scan(&endpoints, &receipts); err != nil || endpoints != 0 || receipts != 0 {
		t.Fatalf("disabled mutation effects: endpoints=%d receipts=%d err=%v", endpoints, receipts, err)
	}
	f.stop()
	f.cfg.WebhookEnabled = true
	f.start()
	created := f.expect("POST", "/api/v1/me/webhooks", create(), 201)
	var result struct {
		Endpoint struct {
			ID string `json:"id"`
		} `json:"endpoint"`
	}
	if err = json.Unmarshal(created, &result); err != nil || result.Endpoint.ID == "" {
		t.Fatalf("endpoint response %s err=%v", created, err)
	}
	var fixedDestination, signingSecret []byte
	if err = db.Pool.QueryRow(ctx, `SELECT e.destination_configuration,k.secret FROM webhook_endpoints e JOIN webhook_signing_keys k ON k.id=e.active_key_id WHERE e.id=$1`, result.Endpoint.ID).Scan(&fixedDestination, &signingSecret); err != nil || len(signingSecret) != 32 || !bytes.Contains(fixedDestination, []byte("https://receiver.example/hook")) {
		t.Fatalf("plaintext configuration: destination=%s secret_bytes=%d err=%v", fixedDestination, len(signingSecret), err)
	}
	f.stop()
	f.cfg.WebhookEnabled = false
	f.start()
	f.expect("GET", "/readyz", "", 200)
	f.expect("GET", "/api/v1/me/webhooks/"+result.Endpoint.ID, "", 200)
	f.expect("POST", "/api/v1/projects/"+project+"/tasks", `{"title":"captured during maintenance"}`, 201)
	var delivery, state string
	var generation int64
	if err = db.Pool.QueryRow(ctx, `SELECT id::text,state,generation FROM webhook_deliveries WHERE endpoint_id=$1`, result.Endpoint.ID).Scan(&delivery, &state, &generation); err != nil || state != "pending" || generation != 1 {
		t.Fatalf("capture during maintenance: id=%s state=%s generation=%d err=%v", delivery, state, generation, err)
	}
	history := f.expect("GET", "/api/v1/me/webhooks/"+result.Endpoint.ID+"/deliveries", "", 200)
	if !bytes.Contains(history, []byte(delivery)) {
		t.Fatalf("history missing captured delivery: %s", history)
	}
	reject = f.expect("POST", "/api/v1/me/webhooks", create(), 503)
	if !bytes.Contains(reject, []byte(`"webhooks_unavailable"`)) {
		t.Fatalf("maintenance create error: %s", reject)
	}
	// An expired, unadmitted claim is recovered without issuing network work.
	if _, err = db.Pool.Exec(ctx, `UPDATE webhook_deliveries SET state='leased',lease_token=$2,lease_claimed_at=now()-interval '2 minutes',lease_until=now()-interval '1 minute',lease_generation=generation,lease_plan_slot=1 WHERE id=$1`, delivery, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		var attempts int
		var lease *string
		if err = db.Pool.QueryRow(ctx, `SELECT state,generation,lease_token::text,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=$1) FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&state, &generation, &lease, &attempts); err != nil {
			t.Fatal(err)
		}
		if state == "pending" && generation == 2 && lease == nil && attempts == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("maintenance recovery: state=%s generation=%d lease=%v attempts=%d", state, generation, lease, attempts)
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Multiple poll intervals prove the recovered item remains unclaimed while disabled.
	time.Sleep(1200 * time.Millisecond)
	var attempts int
	var lease *string
	if err = db.Pool.QueryRow(ctx, `SELECT state,generation,lease_token::text,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=$1) FROM webhook_deliveries WHERE id=$1`, delivery).Scan(&state, &generation, &lease, &attempts); err != nil || state != "pending" || generation != 2 || lease != nil || attempts != 0 {
		t.Fatalf("disabled claim: state=%s generation=%d lease=%v attempts=%d err=%v", state, generation, lease, attempts, err)
	}
	f.stop()
	f.cfg.WebhookEnabled = true
	f.start()
	f.expect("GET", "/readyz", "", 200)
	f.expect("GET", "/api/v1/me/webhooks/"+result.Endpoint.ID, "", 200)
	var restartedDestination, restartedSecret []byte
	if err = db.Pool.QueryRow(ctx, `SELECT e.destination_configuration,k.secret FROM webhook_endpoints e JOIN webhook_signing_keys k ON k.id=e.active_key_id WHERE e.id=$1`, result.Endpoint.ID).Scan(&restartedDestination, &restartedSecret); err != nil || !bytes.Equal(fixedDestination, restartedDestination) || !bytes.Equal(signingSecret, restartedSecret) {
		t.Fatalf("enabled restart changed persisted configuration: %v", err)
	}
	f.stop()
	t.Logf("production application: catalog=6 disabled_create=503 captured_delivery=%s history=200 expired_claim_recovered_generation=2 new_claims=0 enabled_restart=true plaintext_configuration_preserved=true", delivery)
}
