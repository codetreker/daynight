//go:build stress

package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type cutoverProcess struct {
	cmd  *exec.Cmd
	done chan error
	logs bytes.Buffer
}

func startCutoverProcess(t *testing.T, binary string, env map[string]string) *cutoverProcess {
	t.Helper()
	p := &cutoverProcess{cmd: exec.Command(binary), done: make(chan error, 1)}
	p.cmd.Env = os.Environ()
	for key, value := range env {
		p.cmd.Env = append(p.cmd.Env, key+"="+value)
	}
	p.cmd.Stdout = io.Discard
	p.cmd.Stderr = &p.logs
	if err := p.cmd.Start(); err != nil {
		t.Fatal(err)
	}
	go func() { p.done <- p.cmd.Wait() }()
	t.Cleanup(func() {
		if p.cmd.ProcessState == nil {
			_ = p.cmd.Process.Kill()
			<-p.done
		}
	})
	deadline := time.NewTimer(15 * time.Second)
	defer deadline.Stop()
	for {
		client := http.Client{Timeout: time.Second}
		response, err := client.Get(env["DAYNIGHT_PUBLIC_ORIGIN"] + "/readyz")
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return p
			}
		}
		select {
		case err := <-p.done:
			t.Fatalf("process pid=%d exited before ready: %v %s", p.cmd.Process.Pid, err, p.logs.String())
		case <-deadline.C:
			t.Fatalf("process pid=%d not ready", p.cmd.Process.Pid)
		case <-time.After(50 * time.Millisecond):
		}
	}
}
func (p *cutoverProcess) stop(t *testing.T) {
	t.Helper()
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-p.done:
		if err != nil {
			t.Fatalf("pid %d shutdown: %v %s", p.cmd.Process.Pid, err, p.logs.String())
		}
	case <-time.After(10 * time.Second):
		t.Fatalf("pid %d did not stop", p.cmd.Process.Pid)
	}
}

// The binaries are built separately from the identified historical and current
// source trees. The controlled writer inventory consists only of these child
// processes; this test makes no statement about a real deployment fleet.
func TestWebhookIsolatedCutoverAndRollback(t *testing.T) {
	oldBinary, newBinary := os.Getenv("DAYNIGHT_T07_OLD_BINARY"), os.Getenv("DAYNIGHT_T07_NEW_BINARY")
	if oldBinary == "" || newBinary == "" {
		t.Fatal("isolated old and new binaries are required")
	}
	values := processAPIEnvironment(t)
	values["DAYNIGHT_SHUTDOWN_TIMEOUT"] = "5s"
	parsed, err := url.Parse(values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	q := parsed.Query()
	q.Set("application_name", "t07_old_writer")
	parsed.RawQuery = q.Encode()
	values["DAYNIGHT_DATABASE_URL"] = parsed.String()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	old := startCutoverProcess(t, oldBinary, values)
	pool, err := pgxpool.New(ctx, values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	user, session, team, project := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	token := secret.Random("dnst_")
	for _, v := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users (id,uniauth_id,created_at,updated_at) VALUES ($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES($1,$2,$3,now(),now()+interval '1 day')`, []any{session, user, secret.Hash(token)}},
		{`INSERT INTO teams(id,name) VALUES($1,'cutover')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'cutover','https://example.test/cutover')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err = pool.Exec(ctx, v.sql, v.args...); err != nil {
			t.Fatal(err)
		}
	}
	call := func(method, path, body string, want int) []byte {
		t.Helper()
		req, e := http.NewRequestWithContext(ctx, method, values["DAYNIGHT_PUBLIC_ORIGIN"]+path, strings.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		req.AddCookie(&http.Cookie{Name: "daynight_session", Value: token})
		req.Header.Set("Origin", values["DAYNIGHT_PUBLIC_ORIGIN"])
		req.Header.Set("Content-Type", "application/json")
		client := http.Client{Timeout: 5 * time.Second}
		response, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer response.Body.Close()
		data, e := io.ReadAll(response.Body)
		if e != nil || response.StatusCode != want {
			t.Fatalf("%s %s status=%d body=%s err=%v", method, path, response.StatusCode, data, e)
		}
		return data
	}
	path := "/api/v1/projects/" + project + "/tasks"
	call("POST", path, `{"title":"old writer before stop"}`, 201)
	oldPID := old.cmd.Process.Pid
	old.stop(t)
	// Close the observer before counting old process connections: it uses the
	// same application_name but is not part of the writer inventory.
	pool.Close()
	q.Set("application_name", "t07_cutover_observer")
	parsed.RawQuery = q.Encode()
	pool, err = pgxpool.New(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	var connections int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name='t07_old_writer'`).Scan(&connections); err != nil || connections != 0 {
		t.Fatalf("old writer connections=%d err=%v", connections, err)
	}
	values["DAYNIGHT_DATABASE_URL"] = parsed.String()
	keyring := filepath.Join(testStorageRoot(t), "keyring.json")
	if err = os.WriteFile(keyring, []byte(`{"activeKeyId":"primary","keys":{"primary":"`+base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32))+`"}}`), 0600); err != nil {
		t.Fatal(err)
	}
	values["DAYNIGHT_WEBHOOK_KEYRING_FILE"] = keyring
	values["DAYNIGHT_WEBHOOK_ENABLED"] = "0"
	disabled := startCutoverProcess(t, newBinary, values)
	catalog := call("GET", "/api/v1/webhook-event-types", "", 200)
	if !bytes.Contains(catalog, []byte(`"dispatchEnabled":false`)) {
		t.Fatalf("disabled catalog: %s", catalog)
	}
	disabled.stop(t)
	values["DAYNIGHT_WEBHOOK_ENABLED"] = "1"
	enabled := startCutoverProcess(t, newBinary, values)
	create := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"name":"receiver","enabled":true,"destination":{"kind":"http","adapterVersion":"1","configuration":{"url":"https://receiver.example/hook"}},"subscriptions":[{"id":null,"projectId":%q,"eventTypes":["task.created"]}]}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), user, project)
	result := call("POST", "/api/v1/me/webhooks", create, 201)
	var endpoint struct {
		Endpoint struct {
			ID string `json:"id"`
		} `json:"endpoint"`
	}
	if err = json.Unmarshal(result, &endpoint); err != nil || endpoint.Endpoint.ID == "" {
		t.Fatalf("create %s: %v", result, err)
	}
	enabled.stop(t)
	values["DAYNIGHT_WEBHOOK_ENABLED"] = "0"
	rollback := startCutoverProcess(t, newBinary, values)
	call("POST", path, `{"title":"captured during rollback"}`, 201)
	var id string
	var body, hash []byte
	var originalTargetAndBudget string
	var expiry time.Time
	var version int64
	if err = pool.QueryRow(ctx, `SELECT id::text,body,body_sha256,payload_expires_at,policy_version,jsonb_build_object('target',encode(destination_ciphertext,'hex'),'nonce',encode(destination_nonce,'hex'),'master',destination_master_key_id,'revision',destination_revision,'automaticExpires',automatic_expires_at,'schedule',automatic_schedule_at,'attempts',automatic_attempt_count)::text FROM webhook_deliveries WHERE endpoint_id=$1`, endpoint.Endpoint.ID).Scan(&id, &body, &hash, &expiry, &version, &originalTargetAndBudget); err != nil {
		t.Fatal(err)
	}
	var pending, attempts int
	time.Sleep(1200 * time.Millisecond)
	if err = pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM webhook_deliveries WHERE state='pending'),(SELECT count(*) FROM webhook_attempts)`).Scan(&pending, &attempts); err != nil || pending != 1 || attempts != 0 {
		t.Fatalf("rollback pending=%d attempts=%d err=%v", pending, attempts, err)
	}
	rollback.stop(t)
	restarted := startCutoverProcess(t, newBinary, values)
	defer restarted.stop(t)
	call("GET", "/api/v1/me/webhooks/"+endpoint.Endpoint.ID+"/deliveries/"+id, "", 200)
	var bodyAfter, hashAfter []byte
	var targetAndBudgetAfter string
	var expiryAfter time.Time
	var versionAfter int64
	if err = pool.QueryRow(ctx, `SELECT body,body_sha256,payload_expires_at,policy_version,jsonb_build_object('target',encode(destination_ciphertext,'hex'),'nonce',encode(destination_nonce,'hex'),'master',destination_master_key_id,'revision',destination_revision,'automaticExpires',automatic_expires_at,'schedule',automatic_schedule_at,'attempts',automatic_attempt_count)::text FROM webhook_deliveries WHERE id=$1`, id).Scan(&bodyAfter, &hashAfter, &expiryAfter, &versionAfter, &targetAndBudgetAfter); err != nil || !bytes.Equal(body, bodyAfter) || !bytes.Equal(hash, hashAfter) || !expiry.Equal(expiryAfter) || version != versionAfter || originalTargetAndBudget != targetAndBudgetAfter {
		t.Fatalf("rollback responsibility changed: %v", err)
	}
	t.Logf("old_pid=%d stopped=true old_db_connections=0 disabled_pid=%d enabled_pid=%d rollback_pid=%d restart_pid=%d preserved_delivery=%s attempts=0", oldPID, disabled.cmd.Process.Pid, enabled.cmd.Process.Pid, rollback.cmd.Process.Pid, restarted.cmd.Process.Pid, id)
}
