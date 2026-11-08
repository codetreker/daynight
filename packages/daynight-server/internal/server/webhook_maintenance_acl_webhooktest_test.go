//go:build webhooktest

package server

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
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
		ctx, cancel := context.WithTimeout(context.Background(), f.cfg.ShutdownTimeout)
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
	runtime, err := Start(context.Background(), "127.0.0.1:0", time.Second, f.cfg.ShutdownTimeout, testLogger(), handler, handler.Shutdown, app.CancelWork, app.Drain, app.Close)
	if err != nil {
		ctx, cancel := context.WithTimeout(context.Background(), f.cfg.ShutdownTimeout)
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
		ctx, stop := context.WithTimeout(context.Background(), f.cfg.ShutdownTimeout)
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
	c.DatabaseURL = testutil.ScopedDatabaseURL(t)
	c.StorageRoot = filepath.Join(testStorageRoot(t), "storage")
	c.ShutdownTimeout = 5 * time.Second
	c.WebhookEnabled = true
	db, err := postgres.Open(ctx, c.DatabaseURL)
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
	f.cfg.WebhookEnabled = false
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
	f.cfg.WebhookEnabled = true
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
