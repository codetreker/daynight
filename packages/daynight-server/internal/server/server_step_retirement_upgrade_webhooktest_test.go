//go:build webhooktest

package server

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/testdata/testutil"
	"github.com/jackc/pgx/v5/pgxpool"
)

// The pinned baseline includes both compatible clients and the immutable
// historical migration fixture, and ends at schema migration 117.
const stepRetirementBaseline = "cc96e78bad54e34d8b1602f9f797499192406d40"

func TestStepWebhookRetirementUpgrade(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	c := configuredTestConfig()
	c.Database.URL = testutil.ScopedDatabaseURL(t)
	c.Server.ShutdownTimeout = 5 * time.Second
	c.Webhook.Enabled = true
	pool, err := pgxpool.New(ctx, c.Database.URL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	received := make(chan string, 16)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, e := io.ReadAll(r.Body)
		if e != nil {
			t.Error(e)
		}
		received <- string(data)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer receiver.Close()
	roots := x509.NewCertPool()
	roots.AddCert(receiver.Certificate())
	_, source, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate test source")
	}
	moduleDir := filepath.Clean(filepath.Join(filepath.Dir(source), "../.."))
	repoDir := filepath.Clean(filepath.Join(moduleDir, "../.."))
	tempRoot := filepath.Join(repoDir, ".tmp")
	if err = os.MkdirAll(tempRoot, 0700); err != nil {
		t.Fatal(err)
	}
	scratch, err := os.MkdirTemp(tempRoot, "step-webhook-upgrade-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(scratch)
	archive := filepath.Join(scratch, "baseline.tar")
	git := exec.CommandContext(ctx, "git", "-C", repoDir, "archive", "--format=tar", "--output", archive, stepRetirementBaseline, "packages/daynight-server")
	if output, e := git.CombinedOutput(); e != nil {
		t.Fatalf("archive baseline: %v: %s", e, output)
	}
	tar := exec.CommandContext(ctx, "tar", "-xf", archive, "-C", scratch)
	if output, e := tar.CombinedOutput(); e != nil {
		t.Fatalf("extract baseline: %v: %s", e, output)
	}
	baselineDir := filepath.Join(scratch, "packages/daynight-server")
	helper, err := os.ReadFile(filepath.Join(filepath.Dir(source), "server_step_retirement_baseline_webhooktest_test.go"))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(baselineDir, "internal/server/server_step_retirement_baseline_webhooktest_test.go"), helper, 0600); err != nil {
		t.Fatal(err)
	}
	fixturePath := filepath.Join(scratch, "fixture.json")
	certPath := filepath.Join(scratch, "receiver.pem")
	if err = os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: receiver.Certificate().Raw}), 0600); err != nil {
		t.Fatal(err)
	}
	baseline := exec.CommandContext(ctx, "go", "test", "-overlay=scripts/unit-overlay.json", "-tags", "webhooktest", "./internal/server", "-run", "^TestStepRetirementBaselineFixture$", "-count=1", "-timeout=90s")
	baseline.Dir = baselineDir
	baseline.Env = append(os.Environ(), "DAYNIGHT_STEP_BASELINE_OUTPUT="+fixturePath, "DAYNIGHT_STEP_BASELINE_DATABASE="+c.Database.URL, "DAYNIGHT_STEP_RECEIVER="+receiver.URL, "DAYNIGHT_STEP_RECEIVER_CERT="+certPath)
	if output, e := baseline.CombinedOutput(); e != nil {
		t.Fatalf("baseline %s: %v\n%s", stepRetirementBaseline, e, output)
	}
	var fixture map[string]string
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	select {
	case payload := <-received:
		if !strings.Contains(payload, fixture["task"]) || !strings.Contains(payload, "task.created") {
			t.Fatalf("baseline HTTPS body=%s", payload)
		}
	default:
		t.Fatal("baseline delivered state had no HTTPS request")
	}
	var version int
	if err = pool.QueryRow(ctx, `SELECT max(version) FROM schema_migrations`).Scan(&version); err != nil || version != 117 {
		t.Fatalf("baseline ledger=%d err=%v", version, err)
	}
	type binding struct {
		sub, step, other        string
		epoch, config, revision int64
		client, key             string
	}
	readBinding := func(ep string) binding {
		t.Helper()
		var v binding
		err := pool.QueryRow(ctx, `SELECT s.id::text, max(b.id::text) FILTER (WHERE b.event_type='task.step_updated'), COALESCE(max(b.id::text) FILTER (WHERE b.event_type='task.created'),''), s.authorization_epoch,e.config_version,e.destination_revision,e.client_key,e.active_key_id::text FROM webhook_subscriptions s JOIN webhook_endpoints e ON e.id=s.endpoint_id JOIN webhook_bindings b ON b.subscription_id=s.id AND b.deleted_at IS NULL WHERE s.endpoint_id=$1 AND s.deleted_at IS NULL GROUP BY s.id,e.id`, ep).Scan(&v.sub, &v.step, &v.other, &v.epoch, &v.config, &v.revision, &v.client, &v.key)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	only, mixed := readBinding(fixture["only"]), readBinding(fixture["mixed"])
	var ids []string
	rows, err := pool.Query(ctx, `SELECT id::text FROM webhook_deliveries WHERE event_type='task.step_updated' AND state='pending' ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	rows.Close()
	if rows.Err() != nil || len(ids) != 2 {
		t.Fatalf("pending baseline=%v err=%v", ids, rows.Err())
	}
	c.Storage.Root = filepath.Join(scratch, "candidate-storage")
	f := &webhookApplicationFixture{t: t, cfg: c, user: fixture["user"], token: fixture["token"]}
	t.Cleanup(f.stop)
	startControlledMaintenanceFixture(f, roots)
	for _, ep := range []struct {
		id     string
		before binding
	}{{fixture["only"], only}, {fixture["mixed"], mixed}} {
		var config, revision int64
		var client, key string
		if err = pool.QueryRow(ctx, `SELECT config_version,destination_revision,client_key,active_key_id::text FROM webhook_endpoints WHERE id=$1`, ep.id).Scan(&config, &revision, &client, &key); err != nil || config != ep.before.config+1 || revision != ep.before.revision || client != ep.before.client || key != ep.before.key {
			t.Fatalf("endpoint %s config=%d revision=%d err=%v", ep.id, config, revision, err)
		}
		var deleted bool
		if err = pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM webhook_bindings WHERE id=$1`, ep.before.step).Scan(&deleted); err != nil || !deleted {
			t.Fatalf("Step binding %s deleted=%v err=%v", ep.before.step, deleted, err)
		}
	}
	var deleted bool
	var epoch int64
	if err = pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, only.sub).Scan(&deleted, &epoch); err != nil || !deleted || epoch != only.epoch {
		t.Fatalf("only subscription deleted=%v epoch=%d err=%v", deleted, epoch, err)
	}
	if err = pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL,authorization_epoch FROM webhook_subscriptions WHERE id=$1`, mixed.sub).Scan(&deleted, &epoch); err != nil || deleted || epoch != mixed.epoch {
		t.Fatalf("mixed subscription deleted=%v epoch=%d err=%v", deleted, epoch, err)
	}
	if err = pool.QueryRow(ctx, `SELECT deleted_at IS NOT NULL FROM webhook_bindings WHERE id=$1`, mixed.other).Scan(&deleted); err != nil || deleted {
		t.Fatalf("mixed surviving binding deleted=%v err=%v", deleted, err)
	}
	if err = pool.QueryRow(ctx, `SELECT max(version) FROM schema_migrations`).Scan(&version); err != nil || version < 118 {
		t.Fatalf("candidate ledger=%d err=%v", version, err)
	}
	stepPath := "/api/v1/projects/" + fixture["project"] + "/tasks/" + fixture["task"] + "/steps"
	stepReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+f.runtime.Address()+stepPath, strings.NewReader(`{"version":2,"id":"00000002","title":"after upgrade"}`))
	if err != nil {
		t.Fatal(err)
	}
	stepReq.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: fixture["token"]})
	stepReq.Header.Set("Origin", c.Server.PublicOrigin)
	stepReq.Header.Set("Content-Type", "application/json")
	stepResp, err := (&http.Client{Timeout: 5 * time.Second}).Do(stepReq)
	if err != nil {
		t.Fatal(err)
	}
	stepBody, err := io.ReadAll(stepResp.Body)
	_ = stepResp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	stepStatus := stepResp.StatusCode
	// Later delivery units remove the Step route and table entirely. Both the
	// D candidate and the final candidate must stop emitting Step events.
	if stepStatus != http.StatusCreated && stepStatus != http.StatusNotFound {
		t.Fatalf("Step route status=%d body=%s", stepStatus, stepBody)
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM webhook_events WHERE event_type='task.step_updated'`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("Step capture after upgrade=%d err=%v", count, err)
	}
	raw = f.expect("POST", "/api/v1/projects/"+fixture["project"]+"/tasks", `{"title":"after upgrade"}`, 201)
	var task struct {
		ID string `json:"id"`
	}
	if err = json.Unmarshal(raw, &task); err != nil || task.ID == "" {
		t.Fatalf("task response %s err=%v", raw, err)
	}
	deadline := time.NewTimer(45 * time.Second)
	defer deadline.Stop()
	gotTask := false
	terminal := map[string]string{}
	var deliveryID, eventID, attemptID, deliveryState string
	for !gotTask || len(terminal) != len(ids) || deliveryState != "delivered" {
		select {
		case payload := <-received:
			if strings.Contains(payload, "task.step_updated") {
				t.Fatalf("retired Step event sent: %s", payload)
			}
			if strings.Contains(payload, task.ID) {
				gotTask = true
			}
		case <-time.After(100 * time.Millisecond):
			for _, id := range ids {
				var state string
				if err = pool.QueryRow(ctx, `SELECT state FROM webhook_deliveries WHERE id=$1`, id).Scan(&state); err != nil {
					t.Fatal(err)
				}
				switch state {
				case "suppressed", "expired":
					terminal[id] = state
				case "pending", "leased":
				default:
					t.Fatalf("retired delivery %s unexpected state %s", id, state)
				}
			}
			if gotTask {
				err = pool.QueryRow(ctx, `SELECT d.id::text,d.event_id::text,d.state,COALESCE((SELECT id::text FROM webhook_attempts a WHERE a.delivery_id=d.id ORDER BY sequence DESC LIMIT 1),'') FROM webhook_deliveries d JOIN webhook_events e ON e.id=d.event_id WHERE d.endpoint_id=$1 AND e.task_id=$2 AND d.event_type='task.created'`, fixture["mixed"], task.ID).Scan(&deliveryID, &eventID, &deliveryState, &attemptID)
				if err != nil {
					t.Fatal(err)
				}
			}
		case <-deadline.C:
			t.Fatalf("deadline: new delivery=%v terminal=%v IDs=%v", gotTask, terminal, ids)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	f.stop()
	t.Log(fmt.Sprintf("baseline=%s candidate schema=%d retired terminal=%v surviving task=%s event=%s delivery=%s attempt=%s state=%s Step status=%d", stepRetirementBaseline, version, terminal, task.ID, eventID, deliveryID, attemptID, deliveryState, stepStatus))
}
