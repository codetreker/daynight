//go:build startupshutdown && webhooktest

package main

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/codetreker/daynight/packages/daynight-server/internal/config"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

type controlledResolver struct{}

func (controlledResolver) LookupNetIP(context.Context, string, string) ([]netip.Addr, error) {
	return []netip.Addr{netip.MustParseAddr("127.0.0.1")}, nil
}

type controlledHandler struct{ server.Handler }

func (h controlledHandler) BeginShutdown() {
	fmt.Fprintln(os.Stderr, "TRACE begin_claim_stop")
	h.Handler.BeginShutdown()
}
func (h controlledHandler) Shutdown(ctx context.Context) error {
	fmt.Fprintln(os.Stderr, "TRACE routes_shutdown_begin")
	err := h.Handler.Shutdown(ctx)
	fmt.Fprintln(os.Stderr, "TRACE routes_shutdown_end")
	return err
}

// This helper composes the real app and routes with only the outbound TLS
// transport changed in a build-tagged test binary; ordinary builds lack the seam.
func TestWebhookControlledProcessHelper(t *testing.T) {
	if os.Getenv("DAYNIGHT_CONTROLLED_WEBHOOK_HELPER") != "1" {
		return
	}
	_, daynightRoot, err := parseCommand([]string{"--root", os.Getenv("DAYNIGHT_TEST_ROOT")}, os.LookupEnv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	cfg, err := config.LoadServer(daynightRoot, os.LookupEnv)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	certBytes, err := base64.StdEncoding.DecodeString(os.Getenv("DAYNIGHT_CONTROLLED_CA"))
	if err != nil {
		os.Exit(1)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certBytes) {
		os.Exit(1)
	}
	logger := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	app, err := service.OpenAppWithLogger(context.Background(), cfg, logger)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err = app.SetControlledWebhookTestTransport(httpoutbound.NewForTesting(controlledResolver{}, func(ip netip.Addr) bool { return ip.IsLoopback() }, roots)); err != nil {
		os.Exit(1)
	}
	handler, err := server.New(app, cfg, logger)
	if err != nil {
		os.Exit(1)
	}
	wrapped := controlledHandler{handler}
	runtime, err := server.Start(context.Background(), cfg.Server.ListenAddress, cfg.Server.StartupTimeout, cfg.Server.ShutdownTimeout, logger, wrapped, wrapped.Shutdown, app.CancelWork, func(ctx context.Context) error {
		fmt.Fprintln(os.Stderr, "TRACE engine_drain_begin")
		e := app.Drain(ctx)
		fmt.Fprintln(os.Stderr, "TRACE engine_drain_end")
		return e
	}, func(ctx context.Context) error {
		fmt.Fprintln(os.Stderr, "TRACE dependencies_close_begin")
		e := app.Close(ctx)
		fmt.Fprintln(os.Stderr, "TRACE dependencies_close_end")
		return e
	})
	if err != nil {
		os.Exit(1)
	}
	root, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if os.Getenv("DAYNIGHT_CONTROLLED_START_FAILURE") == "1" {
		if err = app.PrestartControlledTestRetention(context.Background()); err != nil {
			os.Exit(1)
		}
		if err = app.Start(root); err == nil {
			fmt.Fprintln(os.Stderr, "TRACE unexpected_start_success")
			os.Exit(1)
		}
		done := app.ControlledTestRunnerDone()
		if done == nil {
			fmt.Fprintln(os.Stderr, "TRACE runner_not_started")
			os.Exit(1)
		}
		cleanup, cancel := context.WithTimeout(context.Background(), cfg.Server.ShutdownTimeout)
		defer cancel()
		if err = runtime.Close(cleanup); err != nil {
			fmt.Fprintln(os.Stderr, "TRACE partial_start_cleanup_error", err)
			os.Exit(1)
		}
		select {
		case <-done:
			fmt.Fprintln(os.Stderr, "TRACE partial_start_runner_stopped")
		default:
			fmt.Fprintln(os.Stderr, "TRACE partial_start_runner_active")
			os.Exit(1)
		}
		if app.Ready(context.Background()) == nil {
			fmt.Fprintln(os.Stderr, "TRACE partial_start_database_still_open")
			os.Exit(1)
		}
		fmt.Fprintln(os.Stderr, "TRACE partial_start_cleanup_complete")
		os.Exit(1)
	}
	if err = app.Start(root); err != nil {
		_ = runtime.Close(context.Background())
		os.Exit(1)
	}
	if err = runtime.Run(root); err != nil {
		fmt.Fprintln(os.Stderr, "TRACE shutdown_error", err)
		os.Exit(1)
	}
	os.Exit(0)
}

func TestWebhookControlledProcessRejectsInvalidRoot(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestWebhookControlledProcessHelper$")
	cmd.Env = grantEnvironment(map[string]string{"DAYNIGHT_CONTROLLED_WEBHOOK_HELPER": "1", "DAYNIGHT_TEST_ROOT": "relative-root-secret"})
	output, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 || !bytes.Contains(output, []byte("root must be a nonempty absolute path")) || bytes.Contains(output, []byte("relative-root-secret")) {
		t.Fatalf("invalid root: error=%v output=%s", err, output)
	}
}

func startControlledWebhookProcess(t *testing.T, values map[string]string, ca []byte) *persistenceProcess {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestWebhookControlledProcessHelper$")
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "DAYNIGHT_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	for k, v := range values {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Env = append(cmd.Env, "DAYNIGHT_CONTROLLED_WEBHOOK_HELPER=1", "DAYNIGHT_CONTROLLED_CA="+base64.StdEncoding.EncodeToString(ca), "DAYNIGHT_TEST_ROOT="+testStorageRoot(t))
	logs := &persistenceProcessLog{}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &persistenceProcess{cmd: cmd, finished: make(chan error, 1), logs: logs}
	go func() { p.finished <- cmd.Wait() }()
	t.Cleanup(func() {
		if !p.stopped {
			if e := p.stop(); e != nil {
				t.Error(e)
			}
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	waitMigrationProcessReady(t, ctx, p, values["DAYNIGHT_PUBLIC_ORIGIN"])
	return p
}

func TestWebhookControlledProcessJointDrain(t *testing.T) {
	received := make(chan []byte, 1)
	canceled := make(chan struct{}, 1)
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		received <- data
		<-r.Context().Done()
		canceled <- struct{}{}
	}))
	defer receiver.Close()
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: receiver.Certificate().Raw})
	values := processAPIEnvironment(t)
	values["DAYNIGHT_SHUTDOWN_TIMEOUT"] = "5s"
	values["DAYNIGHT_WEBHOOK_ENABLED"] = "1"
	adminURL := values["DAYNIGHT_DATABASE_URL"]
	parsed, err := url.Parse(adminURL)
	if err != nil {
		t.Fatal(err)
	}
	application := "controlled_webhook_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	query := parsed.Query()
	query.Set("application_name", application)
	parsed.RawQuery = query.Encode()
	values["DAYNIGHT_DATABASE_URL"] = parsed.String()
	prep := startPersistenceProcess(t, values)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	db, err := pgx.Connect(ctx, adminURL)
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
		{`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'controlled',now(),now()+interval '1 day')`, []any{session, user, secret.Hash(token)}},
		{`INSERT INTO teams(id,name) VALUES($1,'process')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'process','https://example.test/controlled')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err = db.Exec(ctx, q.sql, q.args...); err != nil {
			t.Fatal(err)
		}
	}
	client := &http.Client{Timeout: 10 * time.Second}
	defer client.CloseIdleConnections()
	request := func(method, path string, input any, status int) map[string]any {
		t.Helper()
		body, err := json.Marshal(input)
		if err != nil {
			t.Fatal(err)
		}
		req, err := http.NewRequestWithContext(ctx, method, values["DAYNIGHT_PUBLIC_ORIGIN"]+path, bytes.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Origin", values["DAYNIGHT_PUBLIC_ORIGIN"])
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Daynight-Worker-Protocol", "2")
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil || resp.StatusCode != status {
			t.Fatalf("%s %s: %d %s %v", method, path, resp.StatusCode, data, err)
		}
		var result map[string]any
		if err = json.Unmarshal(data, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	task := request("POST", "/api/v1/projects/"+project+"/tasks", map[string]any{"title": "joint drain", "assignedTo": user, "status": "todo"}, 201)
	taskID := task["id"].(string)
	taskPath := "/api/v1/projects/" + project + "/tasks/" + taskID
	task = request("PATCH", taskPath, map[string]any{"version": task["version"], "allowAgents": true}, 200)
	claim, worker, worktree := uuid.NewString(), uuid.NewString(), uuid.NewString()
	_ = request("POST", taskPath+"/worker-claim", map[string]any{"version": task["version"], "claimId": claim, "workerId": worker, "machine": map[string]any{"id": uuid.NewString(), "name": "machine"}, "platform": "linux", "agent": "codex", "worktreeId": worktree, "agentControlMode": "web"}, 200)
	registration := map[string]any{"protocol": "daynight.session.v1", "registrationId": uuid.NewString(), "claimId": claim, "workerId": worker, "worktreeId": worktree, "provider": "codex", "controllerId": uuid.NewString(), "controllerInstanceId": uuid.NewString()}
	sess := request("POST", taskPath+"/sessions", registration, 200)["session"].(map[string]any)
	sessionID := sess["sessionId"].(string)
	operation := uuid.NewString()
	endpoint := request("POST", "/api/v1/me/webhooks", map[string]any{"operationId": operation, "issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "expectedUserId": user, "name": "receiver", "enabled": true, "destination": map[string]any{"kind": "http", "adapterVersion": "1", "configuration": map[string]any{"url": receiver.URL}}, "subscriptions": []any{map[string]any{"id": nil, "projectId": project, "eventTypes": []string{"task.thread_posted"}}}}, 201)["endpoint"].(map[string]any)["id"].(string)
	if err = prep.stop(); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `UPDATE webhook_operations SET recorded_at=now()-interval '31 days', expires_at=now()-interval '1 day' WHERE operation_id=$1`, operation); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(ctx, `CREATE FUNCTION hold_receipt_gc() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(30); RETURN OLD; END $$; CREATE TRIGGER hold_receipt_gc BEFORE DELETE ON webhook_operations FOR EACH ROW EXECUTE FUNCTION hold_receipt_gc()`); err != nil {
		t.Fatal(err)
	}
	child := startControlledWebhookProcess(t, values, ca)
	snapshotBytes, err := json.Marshal(sess)
	if err != nil {
		t.Fatal(err)
	}
	var initial sp.Snapshot
	if err = json.Unmarshal(snapshotBytes, &initial); err != nil {
		t.Fatal(err)
	}
	grant := request("POST", taskPath+"/sessions/"+sessionID+"/controller-grant", sp.Grant{Protocol: sp.Protocol, ClaimID: claim, ControllerID: registration["controllerId"].(string), ControllerInstanceID: registration["controllerInstanceId"].(string), ExecutionGeneration: initial.ExecutionGeneration, Kind: "bootstrap"}, 200)
	controller, resp, err := websocket.Dial(ctx, strings.Replace(values["DAYNIGHT_PUBLIC_ORIGIN"], "http://", "ws://", 1)+"/api/v1/controller-channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + grant["token"].(string)}}})
	if err != nil {
		t.Fatalf("controller socket: %v %v", resp, err)
	}
	defer controller.CloseNow()
	writeController := func(message sp.ControllerMessage) {
		t.Helper()
		data, e := json.Marshal(message)
		if e != nil {
			t.Fatal(e)
		}
		if e = controller.Write(ctx, websocket.MessageText, data); e != nil {
			t.Fatal(e)
		}
	}
	readController := func(kind string) map[string]json.RawMessage {
		t.Helper()
		for i := 0; i < 10; i++ {
			_, data, e := controller.Read(ctx)
			if e != nil {
				t.Fatal(e)
			}
			var frame map[string]json.RawMessage
			if e = json.Unmarshal(data, &frame); e != nil {
				t.Fatal(e)
			}
			var actual string
			_ = json.Unmarshal(frame["type"], &actual)
			if actual == kind {
				return frame
			}
		}
		t.Fatalf("missing controller frame %s", kind)
		return nil
	}
	writeController(sp.ControllerMessage{Type: "hello", Protocol: sp.Protocol, ControllerFence: initial.ControllerFence, SchemaVersion: 1, ProjectionVersion: 1, ControllerID: registration["controllerId"].(string), ControllerInstanceID: registration["controllerInstanceId"].(string), Provider: "codex", SourceEpoch: uuid.NewString(), LastAckedSourceSeq: "0"})
	welcome := readController("welcome")
	connected, err := sp.DecodeSnapshot(welcome["session"])
	if err != nil {
		t.Fatal(err)
	}
	writeController(sp.ControllerMessage{Type: "sync_state", Protocol: sp.Protocol, ControllerFence: connected.ControllerFence, State: &sp.State{NativeSessionID: connected.Identity.NativeSessionID, InitialInputState: connected.InitialInputState, Synchronized: true, Activity: "initializing"}, PendingInteractions: []sp.TimelineEntry{}})
	readController("sync_ack")
	socket, resp, err := websocket.Dial(ctx, strings.Replace(values["DAYNIGHT_PUBLIC_ORIGIN"], "http://", "ws://", 1)+taskPath+"/sessions/"+sessionID+"/channel", &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer " + token}, "Origin": []string{values["DAYNIGHT_PUBLIC_ORIGIN"]}}})
	if err != nil {
		t.Fatalf("session socket: %v %v", resp, err)
	}
	defer socket.CloseNow()
	if _, _, err = socket.Read(ctx); err != nil {
		t.Fatalf("session snapshot: %v", err)
	}
	_ = request("POST", taskPath+"/thread/messages", map[string]any{"body": "joint delivery"}, 201)
	select {
	case body := <-received:
		if len(body) == 0 {
			t.Fatal("empty TLS body")
		}
	case <-ctx.Done():
		t.Fatal("TLS receiver not reached")
	}
	// Hold a real Task write while the maintenance DELETE is inside its trigger.
	lock, err := db.Begin(ctx)
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
	taskResult := make(chan int, 1)
	go func() {
		req, _ := http.NewRequestWithContext(ctx, "POST", values["DAYNIGHT_PUBLIC_ORIGIN"]+"/api/v1/projects/"+project+"/tasks", strings.NewReader(`{"title":"held HTTP"}`))
		req.Header.Set("Origin", values["DAYNIGHT_PUBLIC_ORIGIN"])
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+token)
		r, e := client.Do(req)
		if e != nil {
			taskResult <- 0
			return
		}
		io.Copy(io.Discard, r.Body)
		r.Body.Close()
		taskResult <- r.StatusCode
	}()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		var httpWait, gcWait bool
		if _, err = lock.Exec(ctx, `SELECT pg_stat_clear_snapshot()`); err != nil {
			t.Fatal(err)
		}
		if err = lock.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id::text FROM projects WHERE id = % FOR UPDATE'), EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Timeout' AND query LIKE 'DELETE FROM webhook_operations%')`, application).Scan(&httpWait, &gcWait); err != nil {
			t.Fatal(err)
		}
		if httpWait && gcWait {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatalf("did not observe concurrent HTTP and GC waits: http=%t gc=%t", httpWait, gcWait)
		case <-ticker.C:
		}
	}
	start := time.Now()
	if err = child.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	readCtx, readCancel := context.WithTimeout(context.Background(), time.Second)
	defer readCancel()
	if _, _, err = socket.Read(readCtx); err == nil || errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		t.Fatalf("Session websocket did not close from server shutdown: %v", err)
	}
	if !errors.Is(err, io.EOF) && websocket.CloseStatus(err) == -1 {
		t.Fatalf("Session socket did not report peer closure: %v", err)
	}
	for {
		_, _, err = controller.Read(readCtx)
		if err != nil {
			break
		}
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) || (!errors.Is(err, io.EOF) && websocket.CloseStatus(err) == -1) {
		t.Fatalf("controller socket did not report peer closure: %v", err)
	}
	if !strings.Contains(child.logs.String(), "TRACE routes_shutdown_begin") || strings.Contains(child.logs.String(), "TRACE engine_drain_begin") {
		t.Fatalf("Session closed outside Routes.Shutdown while HTTP was held: %s", child.logs.String())
	}
	select {
	case <-taskResult:
		t.Fatal("HTTP request escaped lock")
	default:
	}
	var active int
	if err = lock.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1`, application).Scan(&active); err != nil || active == 0 {
		t.Fatalf("PG closed during active HTTP: %d %v", active, err)
	}
	if err = lock.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	held = false
	select {
	case status := <-taskResult:
		if status != 201 {
			t.Fatalf("drained HTTP status=%d", status)
		}
	case <-ctx.Done():
		t.Fatal("HTTP did not complete")
	}
	select {
	case <-canceled:
	case <-ctx.Done():
		t.Fatal("TLS request was not canceled during drain")
	}
	select {
	case err = <-child.finished:
		child.stopped = true
		if err != nil {
			t.Fatalf("child shutdown: %v %s", err, child.logs.String())
		}
	case <-ctx.Done():
		t.Fatal("child did not finish")
	}
	if d := time.Since(start); d > 5*time.Second {
		t.Fatalf("shutdown exceeded budget %s", d)
	}
	logs := child.logs.String()
	positions := []int{strings.Index(logs, "TRACE begin_claim_stop"), strings.Index(logs, "TRACE routes_shutdown_begin"), strings.Index(logs, "TRACE routes_shutdown_end"), strings.Index(logs, "TRACE engine_drain_begin"), strings.Index(logs, "TRACE engine_drain_end"), strings.Index(logs, "TRACE dependencies_close_begin"), strings.Index(logs, "TRACE dependencies_close_end")}
	for i, p := range positions {
		if p < 0 || i > 0 && p <= positions[i-1] {
			t.Fatalf("shutdown order %v: %s", positions, logs)
		}
	}
	var attempts int
	var state string
	var lease, outcome *string
	if err = db.QueryRow(ctx, `SELECT d.state,d.lease_token::text,(SELECT count(*) FROM webhook_attempts WHERE delivery_id=d.id),(SELECT outcome FROM webhook_attempts WHERE delivery_id=d.id) FROM webhook_deliveries d WHERE endpoint_id=$1`, endpoint).Scan(&state, &lease, &attempts, &outcome); err != nil || state != "leased" || lease == nil || attempts != 1 || outcome != nil {
		t.Fatalf("in-flight delivery state=%s lease=%v attempts=%d outcome=%v err=%v", state, lease, attempts, outcome, err)
	}
	if err = db.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1`, application).Scan(&active); err != nil || active != 0 {
		t.Fatalf("PG connections after exit=%d err=%v", active, err)
	}
	t.Logf("controlled test app: Session websocket closed; TLS request canceled; HTTP committed; GC delete blocked at SIGTERM; Routes->Engine->dependencies order observed; state=%s attempts=%d", state, attempts)
}

func TestWebhookControlledPartialStartProcessCleanup(t *testing.T) {
	values := processAPIEnvironment(t)
	values["DAYNIGHT_SHUTDOWN_TIMEOUT"] = "2s"
	values["DAYNIGHT_WEBHOOK_ENABLED"] = "0"
	parsed, err := url.Parse(values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	application := "partial_start_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	query := parsed.Query()
	query.Set("application_name", application)
	parsed.RawQuery = query.Encode()
	values["DAYNIGHT_DATABASE_URL"] = parsed.String()
	receiver := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer receiver.Close()
	ca := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: receiver.Certificate().Raw})
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestWebhookControlledProcessHelper$")
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "DAYNIGHT_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	for k, v := range values {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.Env = append(cmd.Env, "DAYNIGHT_CONTROLLED_WEBHOOK_HELPER=1", "DAYNIGHT_CONTROLLED_START_FAILURE=1", "DAYNIGHT_CONTROLLED_CA="+base64.StdEncoding.EncodeToString(ca), "DAYNIGHT_TEST_ROOT="+testStorageRoot(t))
	output, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 {
		t.Fatalf("partial Start exit: %v %s", err, output)
	}
	text := string(output)
	begin, drained, closed, stopped, finished := strings.Index(text, "TRACE begin_claim_stop"), strings.Index(text, "TRACE engine_drain_end"), strings.Index(text, "TRACE dependencies_close_end"), strings.Index(text, "TRACE partial_start_runner_stopped"), strings.Index(text, "TRACE partial_start_cleanup_complete")
	if begin < 0 || drained <= begin || closed <= drained || stopped <= closed || finished <= stopped {
		t.Fatalf("partial Start cleanup evidence: %s", text)
	}
	listener, err := net.Listen("tcp", values["DAYNIGHT_LISTEN_ADDR"])
	if err != nil {
		t.Fatalf("listener retained after failed Start: %v", err)
	}
	_ = listener.Close()
	db, err := pgx.Connect(ctx, parsed.String())
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close(context.Background())
	var connections int
	if err = db.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()`, application).Scan(&connections); err != nil || connections != 0 {
		t.Fatalf("failed Start retained PG connections: %d %v", connections, err)
	}
	t.Log("controlled Retention.Start failure: Runner started then stopped, shared DB closed, listener reusable, PG connections=0")
}
