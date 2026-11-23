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
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"net/netip"
)

// This helper runs only in the pinned pre-retirement source tree. No background
// dispatch starts, so the two real Step captures remain pending for upgrade.
func TestStepRetirementBaselineFixture(t *testing.T) {
	output := os.Getenv("DAYNIGHT_STEP_BASELINE_OUTPUT")
	if output == "" {
		t.Skip("baseline fixture is run by TestStepWebhookRetirementUpgrade")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	c := configuredTestConfig()
	c.Database.URL = os.Getenv("DAYNIGHT_STEP_BASELINE_DATABASE")
	c.Storage.Root = filepath.Join(filepath.Dir(output), "baseline-storage")
	c.Webhook.Enabled = true
	db, err := postgres.Open(ctx, c.Database.URL)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, session, team, project := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	token := secret.Random("dnst_")
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, secret.Hash(token)}},
		{`INSERT INTO teams(id,name) VALUES($1,'retirement')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'retirement','https://example.test/retirement')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err = db.Pool.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	cert, err := os.ReadFile(os.Getenv("DAYNIGHT_STEP_RECEIVER_CERT"))
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(cert) {
		t.Fatal("invalid receiver certificate")
	}
	var app *service.App
	var handler Handler
	var server *httptest.Server
	start := func(run bool) {
		var e error
		app, e = service.OpenAppWithLogger(ctx, c, testLogger())
		if e != nil {
			t.Fatal(e)
		}
		if e = app.SetControlledWebhookTestTransport(httpoutbound.NewForTesting(maintenanceResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)); e != nil {
			t.Fatal(e)
		}
		handler, e = New(app, c, testLogger())
		if e != nil {
			t.Fatal(e)
		}
		server = httptest.NewServer(handler)
		if run {
			if e = app.Start(ctx); e != nil {
				t.Fatal(e)
			}
		}
	}
	stop := func() {
		if server == nil {
			return
		}
		server.Close()
		if err := handler.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
		app.CancelWork()
		if err := app.Drain(ctx); err != nil {
			t.Error(err)
		}
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
		server = nil
	}
	start(true)
	defer stop()
	request := func(method, path string, input any, want int) map[string]any {
		t.Helper()
		raw, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(ctx, method, server.URL+path, bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		req.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: token})
		req.Header.Set("Origin", c.Server.PublicOrigin)
		req.Header.Set("Content-Type", "application/json")
		res, err := server.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		data, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		if res.StatusCode != want {
			t.Fatalf("%s %s: %d want %d: %s", method, path, res.StatusCode, want, data)
		}
		var result map[string]any
		if err = json.Unmarshal(data, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	create := func(name string, events []string) string {
		result := request("POST", "/api/v1/me/webhooks", map[string]any{"operationId": uuid.NewString(), "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": user, "name": name, "enabled": true, "clientKey": "retire-" + name, "destination": map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": os.Getenv("DAYNIGHT_STEP_RECEIVER")}}, "subscriptions": []any{map[string]any{"id": nil, "projectId": project, "eventTypes": events}}}, 201)
		return result["endpoint"].(map[string]any)["id"].(string)
	}
	only := create("only", []string{"task.step_updated"})
	mixed := create("mixed", []string{"task.step_updated", "task.created"})
	task := request("POST", "/api/v1/projects/"+project+"/tasks", map[string]any{"title": "baseline"}, 201)
	id := task["id"].(string)
	for {
		var state string
		if err = db.Pool.QueryRow(ctx, `SELECT state FROM webhook_deliveries WHERE endpoint_id=$1 AND event_type='task.created'`, mixed).Scan(&state); err != nil {
			t.Fatal(err)
		}
		if state == "delivered" {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("baseline TLS delivery state=%s: %v", state, ctx.Err())
		case <-time.After(100 * time.Millisecond):
		}
	}
	stop()
	start(false)
	request("POST", "/api/v1/projects/"+project+"/tasks/"+id+"/steps", map[string]any{"version": task["version"], "id": "00000001", "title": "before upgrade"}, 201)
	var deliveries int
	if err = db.Pool.QueryRow(ctx, `SELECT count(*) FROM webhook_deliveries WHERE event_type='task.step_updated' AND state='pending'`).Scan(&deliveries); err != nil || deliveries != 2 {
		t.Fatalf("baseline pending=%d err=%v", deliveries, err)
	}
	raw, err := json.Marshal(map[string]string{"user": user, "token": token, "project": project, "task": id, "only": only, "mixed": mixed})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(output, raw, 0600); err != nil {
		t.Fatal(err)
	}
}
