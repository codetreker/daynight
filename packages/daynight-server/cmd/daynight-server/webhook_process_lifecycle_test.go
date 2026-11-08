package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// The child is the real process entrypoint in the test binary. PostgreSQL row
// locking provides the controlled HTTP drain barrier; no transport is replaced.
func TestWebhookProcessShutdownPreservesCapturedWork(t *testing.T) {
	values := processAPIEnvironment(t)
	values["DAYNIGHT_SHUTDOWN_TIMEOUT"] = "5s"
	values["DAYNIGHT_WEBHOOK_ENABLED"] = "1"
	adminURL := values["DAYNIGHT_DATABASE_URL"]
	parsed, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	application := "webhook_lifecycle_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	query := parsed.Query()
	query.Set("application_name", application)
	parsed.RawQuery = query.Encode()
	values["DAYNIGHT_DATABASE_URL"] = parsed.String()
	child := startPersistenceProcess(t, values)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	observer, err := pgx.Connect(ctx, adminURL)
	if err != nil {
		t.Fatal(err)
	}
	defer observer.Close(context.Background())
	user, session, team, project, token := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), secret.Random("dnst_")
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, secret.Hash(token)}},
		{`INSERT INTO teams(id,name) VALUES($1,'process')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'process','https://example.test/process')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err = observer.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	client := &http.Client{Timeout: 10 * time.Second}
	defer client.CloseIdleConnections()
	request := func(method, path string, body []byte) (*http.Response, []byte, error) {
		req, e := http.NewRequestWithContext(ctx, method, values["DAYNIGHT_PUBLIC_ORIGIN"]+path, bytes.NewReader(body))
		if e != nil {
			return nil, nil, e
		}
		req.Header.Set("Origin", values["DAYNIGHT_PUBLIC_ORIGIN"])
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(&http.Cookie{Name: "daynight_session", Value: token})
		response, e := client.Do(req)
		if e != nil {
			return nil, nil, e
		}
		data, e := io.ReadAll(response.Body)
		_ = response.Body.Close()
		return response, data, e
	}
	input, err := json.Marshal(map[string]any{"operationId": uuid.NewString(), "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": user, "name": "receiver", "enabled": true, "destination": map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": "https://receiver.example/hook"}}, "subscriptions": []any{map[string]any{"id": nil, "projectId": project, "eventTypes": []string{"task.created"}}}})
	if err != nil {
		t.Fatal(err)
	}
	resp, body, err := request("POST", "/api/v1/me/webhooks", input)
	if err != nil || resp.StatusCode != 201 {
		t.Fatalf("create endpoint: %v %v %s", resp, err, body)
	}
	var created struct {
		Endpoint struct {
			ID string `json:"id"`
		} `json:"endpoint"`
	}
	if err = json.Unmarshal(body, &created); err != nil || created.Endpoint.ID == "" {
		t.Fatalf("endpoint: %s %v", body, err)
	}
	lock, err := observer.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	held := true
	t.Cleanup(func() {
		if held {
			_ = lock.Rollback(context.Background())
		}
	})
	if _, err = lock.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project); err != nil {
		t.Fatal(err)
	}
	type httpResult struct {
		status int
		body   []byte
		err    error
	}
	finished := make(chan httpResult, 1)
	go func() {
		r, b, e := request("POST", "/api/v1/projects/"+project+"/tasks", []byte(`{"title":"during process drain"}`))
		status := 0
		if r != nil {
			status = r.StatusCode
		}
		finished <- httpResult{status, b, e}
	}()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err = lock.Exec(ctx, `SELECT pg_stat_clear_snapshot()`); err != nil {
			t.Fatal(err)
		}
		var waiting bool
		if err = lock.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id::text FROM projects WHERE id = % FOR UPDATE')`, application).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case r := <-finished:
			t.Fatalf("request did not block: %+v", r)
		case <-ctx.Done():
			t.Fatal("request did not reach lock")
		case <-ticker.C:
		}
	}
	started := time.Now()
	if err = child.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	for {
		conn, e := net.DialTimeout("tcp", values["DAYNIGHT_LISTEN_ADDR"], 100*time.Millisecond)
		if e != nil {
			break
		}
		_ = conn.Close()
		select {
		case <-ctx.Done():
			t.Fatal("listener did not close")
		case <-ticker.C:
		}
	}
	select {
	case r := <-finished:
		t.Fatalf("HTTP drained before lock release: %+v", r)
	default:
	}
	var connections int
	if err = lock.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1`, application).Scan(&connections); err != nil || connections == 0 {
		t.Fatalf("database released while HTTP active: connections=%d err=%v", connections, err)
	}
	if err = lock.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	held = false
	var actual httpResult
	select {
	case actual = <-finished:
	case <-ctx.Done():
		t.Fatal("HTTP request did not drain")
	}
	if actual.err != nil || actual.status != 201 {
		t.Fatalf("drained task: %+v", actual)
	}
	select {
	case err = <-child.finished:
		child.stopped = true
		if err != nil {
			t.Fatalf("shutdown: %v %s", err, child.logs.String())
		}
	case <-ctx.Done():
		t.Fatal("child did not exit")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("shutdown exceeded budget: %s", elapsed)
	}
	var state string
	var attempts, events int
	var lease *string
	if err = observer.QueryRow(ctx, `SELECT d.state,d.lease_token::text,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d.id),(SELECT count(*) FROM webhook_events WHERE id=d.event_id) FROM webhook_deliveries d WHERE d.endpoint_id=$1`, created.Endpoint.ID).Scan(&state, &lease, &attempts, &events); err != nil || state != "pending" || lease != nil || attempts != 0 || events != 1 {
		t.Fatalf("post-shutdown capture state=%s lease=%v attempts=%d events=%d err=%v", state, lease, attempts, events, err)
	}
	if err = observer.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1`, application).Scan(&connections); err != nil || connections != 0 {
		t.Fatalf("process retained connections: %d %v", connections, err)
	}
	values["DAYNIGHT_WEBHOOK_ENABLED"] = "0"
	restarted := startPersistenceProcess(t, values)
	if err = observer.QueryRow(ctx, `SELECT d.state,d.lease_token::text,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d.id),(SELECT count(*) FROM webhook_events WHERE id=d.event_id) FROM webhook_deliveries d WHERE d.endpoint_id=$1`, created.Endpoint.ID).Scan(&state, &lease, &attempts, &events); err != nil || state != "pending" || lease != nil || attempts != 0 || events != 1 {
		t.Fatalf("disabled restart changed captured work: state=%s lease=%v attempts=%d events=%d err=%v", state, lease, attempts, events, err)
	}
	if err = restarted.stop(); err != nil {
		t.Fatalf("disabled restart shutdown: %v", err)
	}
	listener, err := net.Listen("tcp", values["DAYNIGHT_LISTEN_ADDR"])
	if err != nil {
		t.Fatalf("restart shutdown retained listener: %v", err)
	}
	_ = listener.Close()
	if err = observer.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1`, application).Scan(&connections); err != nil || connections != 0 {
		t.Fatalf("restart shutdown retained connections: %d %v", connections, err)
	}
	if strings.Contains(restarted.logs.String(), values["DAYNIGHT_STORAGE_ROOT"]) {
		t.Fatal("startup log leaked storage path")
	}
	t.Logf("SIGTERM process HTTP-drain observed: listener_closed=true DB_in_use_before_release=true source_commit=201 event=1 delivery=pending claims=0 attempts=0 DB_connections_after_exit=0 disabled_restart_without_keyring=true")

}
