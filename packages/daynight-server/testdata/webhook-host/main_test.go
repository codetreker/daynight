//go:build webhookfixture

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/tls"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestExecutableHostRealSourcesAndCleanup(t *testing.T) {
	dbURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	token := secret.Random("dnst_")
	pat := secret.Random("dnpat_")
	memberToken, memberPAT := secret.Random("dnst_"), secret.Random("dnpat_")
	cmd := exec.CommandContext(ctx, "go", "run", "-tags", "webhookfixture", ".")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = append(os.Environ(), "DAYNIGHT_WEBHOOK_FIXTURE_TOKEN="+token, "DAYNIGHT_WEBHOOK_FIXTURE_PAT="+pat, "DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN="+memberToken, "DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT="+memberPAT)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			_ = cmd.Wait()
		}
	})
	scanner := bufio.NewScanner(stdout)
	ready := make(chan string, 1)
	go func() {
		if scanner.Scan() {
			ready <- scanner.Text()
		} else {
			ready <- ""
		}
	}()
	var line string
	select {
	case line = <-ready:
	case <-ctx.Done():
		t.Fatal("fixture did not start")
	}
	var i info
	if err = json.Unmarshal([]byte(line), &i); err != nil || i.URL == "" || i.ReceiverURL == "" || i.Schema == "" {
		t.Fatalf("invalid readiness: %s (%v)", line, err)
	}
	client := &http.Client{Timeout: 5 * time.Second}
	call := func(method, path, body string, withAuth bool) (int, []byte) {
		t.Helper()
		r, e := http.NewRequestWithContext(ctx, method, i.URL+path, strings.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		r.Header.Set("Origin", i.Origin)
		r.Header.Set("Content-Type", "application/json")
		if withAuth {
			r.AddCookie(&http.Cookie{Name: "daynight_session", Value: token})
		}
		res, e := client.Do(r)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		b, e := io.ReadAll(res.Body)
		if e != nil {
			t.Fatal(e)
		}
		if path != "/api/v1/me" && res.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("missing no-store for %s", path)
		}
		if withAuth && res.Header.Get("Daynight-User-ID") != i.UserID {
			t.Fatal("wrong authenticated identity")
		}
		return res.StatusCode, b
	}
	status, _ := call("GET", "/api/v1/webhook-event-types", "", false)
	if status != 401 {
		t.Fatalf("unauthenticated status=%d", status)
	}
	bearer, err := http.NewRequestWithContext(ctx, http.MethodGet, i.URL+"/api/v1/webhook-event-types", nil)
	if err != nil {
		t.Fatal(err)
	}
	bearer.Header.Set("Authorization", "Bearer "+pat)
	bearerRes, err := client.Do(bearer)
	if err != nil {
		t.Fatal(err)
	}
	bearerRes.Body.Close()
	if bearerRes.StatusCode != 200 || bearerRes.Header.Get("Daynight-User-ID") != i.UserID {
		t.Fatal("PAT authentication failed")
	}
	status, cookieMe := call("GET", "/api/v1/me", "", true)
	if status != 200 {
		t.Fatalf("cookie me status=%d", status)
	}
	bearerMe, err := http.NewRequestWithContext(ctx, http.MethodGet, i.URL+"/api/v1/me", nil)
	if err != nil {
		t.Fatal(err)
	}
	bearerMe.Header.Set("Authorization", "Bearer "+pat)
	meRes, err := client.Do(bearerMe)
	if err != nil {
		t.Fatal(err)
	}
	patMe, err := io.ReadAll(meRes.Body)
	meRes.Body.Close()
	if err != nil || meRes.StatusCode != 200 || meRes.Header.Get("Daynight-User-ID") != i.UserID || !bytes.Equal(cookieMe, patMe) {
		t.Fatal("cookie and PAT me identities differ")
	}
	foreign, err := http.NewRequestWithContext(ctx, http.MethodPost, i.URL+"/api/v1/me/webhooks", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	foreign.Header.Set("Origin", "https://foreign.example")
	foreign.Header.Set("Content-Type", "application/json")
	foreign.AddCookie(&http.Cookie{Name: "daynight_session", Value: token})
	foreignRes, err := client.Do(foreign)
	if err != nil {
		t.Fatal(err)
	}
	foreignRes.Body.Close()
	if foreignRes.StatusCode != 403 || foreignRes.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("foreign origin was allowed")
	}
	status, _ = call("GET", "/api/v1/webhook-event-types", "", true)
	if status != 200 {
		t.Fatalf("catalog status=%d", status)
	}
	payload := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"name":"fixture","enabled":true,"destination":{"kind":"http","adapterVersion":"1","configuration":{"url":%q}},"subscriptions":[{"id":null,"projectId":%q,"eventTypes":["task.created"]}]}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), i.UserID, i.ReceiverURL, i.ProjectID)
	status, b := call("POST", "/api/v1/me/webhooks", payload, true)
	if status != 201 {
		t.Fatalf("endpoint status=%d body=%s", status, b)
	}
	var created struct {
		Endpoint struct {
			ID string `json:"id"`
		} `json:"endpoint"`
	}
	if err = json.Unmarshal(b, &created); err != nil || created.Endpoint.ID == "" {
		t.Fatalf("endpoint response %s", b)
	}
	teamPayload := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"name":"team fixture","enabled":true,"destination":{"kind":"http","adapterVersion":"1","configuration":{"url":%q}},"subscriptions":[]}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), i.UserID, i.ReceiverURL)
	teamBase := "/api/v1/teams/" + i.TeamID
	status, b = call("POST", teamBase+"/webhooks", teamPayload, true)
	if status != 201 {
		t.Fatalf("team endpoint %d %s", status, b)
	}
	var teamEndpoint struct {
		Endpoint struct {
			ID string `json:"id"`
		} `json:"endpoint"`
	}
	if err = json.Unmarshal(b, &teamEndpoint); err != nil || teamEndpoint.Endpoint.ID == "" {
		t.Fatal("team endpoint missing")
	}
	memberCall := func(method, path, body string, usePAT bool) (int, []byte) {
		t.Helper()
		req, e := http.NewRequestWithContext(ctx, method, i.URL+path, strings.NewReader(body))
		if e != nil {
			t.Fatal(e)
		}
		req.Header.Set("Origin", i.Origin)
		req.Header.Set("Content-Type", "application/json")
		if usePAT {
			req.Header.Set("Authorization", "Bearer "+memberPAT)
		} else {
			req.AddCookie(&http.Cookie{Name: "daynight_session", Value: memberToken})
		}
		res, e := client.Do(req)
		if e != nil {
			t.Fatal(e)
		}
		defer res.Body.Close()
		out, e := io.ReadAll(res.Body)
		if e != nil || res.Header.Get("Daynight-User-ID") != i.MemberID {
			t.Fatal("wrong member identity")
		}
		return res.StatusCode, out
	}
	status, b = memberCall("GET", "/api/v1/me", "", false)
	if status != 200 {
		t.Fatalf("member me=%d %s", status, b)
	}
	status, b = memberCall("GET", "/api/v1/me", "", true)
	if status != 200 {
		t.Fatalf("member PAT me=%d %s", status, b)
	}
	status, b = memberCall("GET", teamBase, "", false)
	if status != 200 || !bytes.Contains(b, []byte(`"role":"member"`)) {
		t.Fatalf("team member=%d %s", status, b)
	}
	status, b = memberCall("GET", teamBase+"/webhooks/"+teamEndpoint.Endpoint.ID, "", false)
	if status != 200 || bytes.Contains(b, []byte(i.ReceiverURL)) {
		t.Fatalf("member webhook view=%d %s", status, b)
	}
	memberPayload := fmt.Sprintf(`{"operationId":%q,"issuedAt":%q,"expectedUserId":%q,"name":"denied","enabled":true,"destination":{"kind":"http","adapterVersion":"1","configuration":{"url":%q}},"subscriptions":[]}`, uuid.NewString(), time.Now().UTC().Format(time.RFC3339Nano), i.MemberID, i.ReceiverURL)
	status, b = memberCall("POST", teamBase+"/webhooks", memberPayload, true)
	if status != 403 {
		t.Fatalf("member write=%d %s", status, b)
	}
	status, b = memberCall("POST", "/__fixture/runner/start", "", false)
	if status != 403 {
		t.Fatalf("member control=%d %s", status, b)
	}
	status, b = call("POST", "/api/v1/projects/"+i.ProjectID+"/tasks", `{"title":"client fixture task"}`, true)
	if status != 201 {
		t.Fatalf("task status=%d body=%s", status, b)
	}
	var createdTask struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(b, &createdTask); err != nil || createdTask.ID == "" {
		t.Fatalf("created task missing identity: %s (%v)", b, err)
	}
	status, b = call("GET", "/api/v1/projects/"+i.ProjectID+"/tasks/"+createdTask.ID+"?include=session", "", true)
	var observed struct {
		ID      string `json:"id"`
		Session struct {
			Observation string `json:"observation"`
			Reason      string `json:"reason"`
		} `json:"session"`
	}
	if err := json.Unmarshal(b, &observed); status != 200 || err != nil || observed.ID != createdTask.ID || observed.Session.Observation != "observed" || observed.Session.Reason != "not_started" {
		t.Fatalf("task observation status=%d body=%s err=%v", status, b, err)
	}
	status, b = call("GET", "/api/v1/me/webhooks/"+created.Endpoint.ID+"/deliveries", "", true)
	if status != 200 || !bytes.Contains(b, []byte("client fixture task")) {
		t.Fatalf("captured delivery status=%d body=%s", status, b)
	}
	status, _ = call("PUT", "/__fixture/receiver/status", `{"status":503}`, false)
	if status != 401 {
		t.Fatalf("unauthenticated status control=%d", status)
	}
	status, b = call("PUT", "/__fixture/receiver/status", `{"status":503}`, true)
	if status != 204 {
		t.Fatalf("receiver status control=%d %s", status, b)
	}
	status, b = call("POST", "/__fixture/runner/start", "", true)
	if status != 204 {
		t.Fatalf("start=%d %s", status, b)
	}
	deadline := time.Now().Add(8 * time.Second)
	for {
		status, b = call("GET", "/__fixture/receiver", "", true)
		var items []receipt
		if status != 200 || json.Unmarshal(b, &items) != nil {
			t.Fatalf("receiver %d %s", status, b)
		}
		if len(items) > 0 {
			if items[0].EventID == "" || items[0].Signature == "" || items[0].Status != 503 || !bytes.Contains(items[0].Body, []byte("cc.daynight.task.created.v1")) {
				t.Fatal("receiver did not capture actual source bytes and authentication")
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("real runner did not reach controlled TLS receiver")
		}
		time.Sleep(20 * time.Millisecond)
	}
	status, b = call("POST", "/__fixture/runner/stop", "", true)
	if status != 204 {
		t.Fatalf("stop=%d %s", status, b)
	}
	status, b = call("POST", "/__fixture/shutdown", "", true)
	if status != 204 {
		t.Fatalf("shutdown=%d %s", status, b)
	}
	if err = cmd.Wait(); err != nil {
		t.Fatalf("fixture exit: %v (%s)", err, stderr.String())
	}
	if strings.Contains(stderr.String(), token) || strings.Contains(line, token) || strings.Contains(stderr.String(), pat) || strings.Contains(line, pat) || strings.Contains(stderr.String(), memberToken) || strings.Contains(line, memberToken) || strings.Contains(stderr.String(), memberPAT) || strings.Contains(line, memberPAT) {
		t.Fatal("fixture exposed session token in process output")
	}
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	var exists bool
	if err = admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, i.Schema).Scan(&exists); err != nil || exists {
		t.Fatalf("schema still present=%t: %v", exists, err)
	}
}

func TestStartupFailureRemovesCreatedSchema(t *testing.T) {
	dbURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var schema string
	_, err := startWithStore(ctx, dbURL, secret.Random("dnst_"), secret.Random("dnpat_"), secret.Random("dnst_"), secret.Random("dnpat_"), func(_ context.Context, scopedURL string) (*postgres.Store, error) {
		u, parseErr := url.Parse(scopedURL)
		if parseErr != nil {
			return nil, parseErr
		}
		schema = u.Query().Get("search_path")
		return nil, errors.New("injected store initialization failure")
	})
	if err == nil || schema == "" {
		t.Fatal("startup failure was not injected after schema creation")
	}
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	var exists bool
	if err = admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, schema).Scan(&exists); err != nil || exists {
		t.Fatalf("schema still present=%t: %v", exists, err)
	}
}

func TestShutdownWaitsForConcurrentRunnerStart(t *testing.T) {
	dbURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	token := secret.Random("dnst_")
	f, err := start(ctx, dbURL, token, secret.Random("dnpat_"), secret.Random("dnst_"), secret.Random("dnpat_"))
	if err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	f.beforeRunnerStart = func() { close(entered); <-release }
	result := make(chan error, 1)
	go func() {
		req, e := http.NewRequestWithContext(ctx, http.MethodPost, f.info.URL+"/__fixture/runner/start", nil)
		if e != nil {
			result <- e
			return
		}
		req.Header.Set("Origin", f.info.Origin)
		req.AddCookie(&http.Cookie{Name: "daynight_session", Value: token})
		res, e := http.DefaultClient.Do(req)
		if e == nil {
			res.Body.Close()
			if res.StatusCode != 204 {
				e = fmt.Errorf("start status %d", res.StatusCode)
			}
		}
		result <- e
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("start handler did not enter")
	}
	closed := make(chan error, 1)
	go func() {
		cleanup, c := context.WithTimeout(context.Background(), 10*time.Second)
		defer c()
		closed <- f.close(cleanup)
	}()
	deadline := time.Now().Add(4 * time.Second)
	for {
		conn, e := net.DialTimeout("tcp", f.listener.Addr().String(), 100*time.Millisecond)
		if e != nil {
			break
		}
		conn.Close()
		if time.Now().After(deadline) {
			unblock()
			t.Fatal("shutdown did not close listener")
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case err = <-closed:
		unblock()
		t.Fatalf("shutdown returned while start handler was active: %v", err)
	default:
	}
	unblock()
	if err = <-result; err != nil {
		t.Fatal(err)
	}
	if err = <-closed; err != nil {
		t.Fatalf("shutdown failed: %v", err)
	}
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	var exists bool
	if err = admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, f.schema).Scan(&exists); err != nil || exists {
		t.Fatalf("schema still present=%t: %v", exists, err)
	}
}

func retryFixtureCleanup(t *testing.T, f *fixture, initialErr error) {
	t.Helper()
	t.Errorf("initial fixture cleanup failed: %v", initialErr)
	cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	if err := f.close(cleanup); err != nil {
		t.Errorf("fixture cleanup retry failed: %v", err)
	}
}

func TestShutdownWaitsForObservationEngineBeforeClosingDatabase(t *testing.T) {
	dbURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	f, err := start(ctx, dbURL, secret.Random("dnst_"), secret.Random("dnpat_"), secret.Random("dnst_"), secret.Random("dnpat_"))
	if err != nil {
		t.Fatal(err)
	}
	op, err := f.engine.BeginOperation()
	if err != nil {
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		if closeErr := f.close(cleanup); closeErr != nil {
			retryFixtureCleanup(t, f, closeErr)
		}
		t.Fatal(err)
	}
	var releaseOnce sync.Once
	release := func() { releaseOnce.Do(op.Close) }
	var closeErr error
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		closeErr = f.close(cleanup)
	}()
	t.Cleanup(func() {
		release()
		select {
		case <-finished:
			if closeErr != nil {
				retryFixtureCleanup(t, f, closeErr)
			}
		case <-time.After(12 * time.Second):
			t.Error("fixture cleanup did not finish")
		}
	})
	select {
	case <-op.Stopping():
	case <-finished:
		t.Fatalf("shutdown ended before stopping the engine: %v", closeErr)
	case <-ctx.Done():
		t.Fatal("shutdown did not reach the engine")
	}
	select {
	case <-finished:
		t.Fatalf("shutdown returned while engine operation was active: %v", closeErr)
	default:
	}
	var value int
	if err := f.db.Pool.QueryRow(ctx, "SELECT 1").Scan(&value); err != nil || value != 1 {
		t.Fatalf("database closed before engine drained: %v", err)
	}
	release()
	select {
	case <-finished:
		if closeErr != nil {
			t.Fatalf("shutdown failed: %v", closeErr)
		}
	case <-ctx.Done():
		t.Fatal("shutdown did not finish after engine operation ended")
	}
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	var exists bool
	if err = admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, f.schema).Scan(&exists); err != nil || exists {
		t.Fatalf("schema still present=%t: %v", exists, err)
	}
}

func TestExecutableForcesStalledBodyAndRemovesSchema(t *testing.T) {
	dbURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 35*time.Second)
	defer cancel()
	token := secret.Random("dnst_")
	cmd := exec.CommandContext(ctx, "go", "run", "-tags", "webhookfixture", ".")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = append(os.Environ(), "DAYNIGHT_WEBHOOK_FIXTURE_TOKEN="+token, "DAYNIGHT_WEBHOOK_FIXTURE_PAT="+secret.Random("dnpat_"), "DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN="+secret.Random("dnst_"), "DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT="+secret.Random("dnpat_"))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			_ = cmd.Wait()
		}
	})
	scanner := bufio.NewScanner(stdout)
	line := make(chan string, 1)
	go func() {
		if scanner.Scan() {
			line <- scanner.Text()
		} else {
			line <- ""
		}
	}()
	var i info
	select {
	case value := <-line:
		if err = json.Unmarshal([]byte(value), &i); err != nil || i.URL == "" {
			t.Fatalf("invalid readiness %v", err)
		}
	case <-ctx.Done():
		t.Fatal("fixture did not start")
	}
	target, err := url.Parse(i.URL)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.DialTimeout("tcp", target.Host, 3*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	_, err = fmt.Fprintf(conn, "POST /api/v1/me/webhooks HTTP/1.1\r\nHost: %s\r\nOrigin: %s\r\nCookie: daynight_session=%s\r\nContent-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n{", target.Host, i.Origin, token)
	if err != nil {
		t.Fatal(err)
	}
	line100, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || !strings.Contains(line100, "100 Continue") {
		t.Fatalf("body read did not start: %q %v", line100, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, i.URL+"/__fixture/shutdown", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", i.Origin)
	req.AddCookie(&http.Cookie{Name: "daynight_session", Value: token})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("shutdown status=%d", res.StatusCode)
	}
	if err = cmd.Wait(); err != nil {
		t.Fatalf("fixture exit: %v (%s)", err, stderr.String())
	}
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	var exists bool
	if err = admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, i.Schema).Scan(&exists); err != nil || exists {
		t.Fatalf("stalled request leaked schema=%t: %v", exists, err)
	}
}

func TestExecutableForcesStalledTLSReceiverAndRemovesSchema(t *testing.T) {
	dbURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	token := secret.Random("dnst_")
	cmd := exec.CommandContext(ctx, "go", "run", "-tags", "webhookfixture", ".")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Env = append(os.Environ(), "DAYNIGHT_WEBHOOK_FIXTURE_TOKEN="+token, "DAYNIGHT_WEBHOOK_FIXTURE_PAT="+secret.Random("dnpat_"), "DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_TOKEN="+secret.Random("dnst_"), "DAYNIGHT_WEBHOOK_FIXTURE_MEMBER_PAT="+secret.Random("dnpat_"))
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
			_ = cmd.Wait()
		}
	})
	scanner := bufio.NewScanner(stdout)
	line := make(chan string, 1)
	go func() {
		if scanner.Scan() {
			line <- scanner.Text()
		} else {
			line <- ""
		}
	}()
	var i info
	select {
	case value := <-line:
		if err = json.Unmarshal([]byte(value), &i); err != nil || i.ReceiverURL == "" {
			t.Fatalf("invalid readiness %v", err)
		}
	case <-ctx.Done():
		t.Fatal("fixture did not start")
	}
	target, err := url.Parse(i.ReceiverURL)
	if err != nil {
		t.Fatal(err)
	}
	// This hostile client deliberately ignores the ephemeral certificate; the real
	// runner uses a dedicated trust root and verifies hostname and certificate.
	dialer := &net.Dialer{Timeout: 3 * time.Second}
	conn, err := tls.DialWithDialer(dialer, "tcp", target.Host, &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	_, err = fmt.Fprintf(conn, "POST %s HTTP/1.1\r\nHost: %s\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n{", target.RequestURI(), target.Host)
	if err != nil {
		t.Fatal(err)
	}
	line100, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || !strings.Contains(line100, "100 Continue") {
		t.Fatalf("receiver body read did not start: %q %v", line100, err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, i.URL+"/__fixture/shutdown", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Origin", i.Origin)
	req.AddCookie(&http.Cookie{Name: "daynight_session", Value: token})
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 204 {
		t.Fatalf("shutdown status=%d", res.StatusCode)
	}
	if err = cmd.Wait(); err != nil {
		t.Fatalf("fixture exit: %v (%s)", err, stderr.String())
	}
	admin, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	var exists bool
	if err = admin.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, i.Schema).Scan(&exists); err != nil || exists {
		t.Fatalf("stalled receiver leaked schema=%t: %v", exists, err)
	}
}

type schemaLossTracer struct {
	mu                              sync.Mutex
	schema, owner                   string
	queries                         []string
	drop                            bool
	pending, armed, lost, committed atomic.Bool
	diag                            string
	verify                          *pgxpool.Pool
}

func (x *schemaLossTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	sql := strings.TrimSpace(q.SQL)
	x.mu.Lock()
	x.queries = append(x.queries, sql)
	x.mu.Unlock()
	if strings.HasPrefix(sql, "CREATE SCHEMA ") && !x.drop {
		x.mu.Lock()
		x.schema = strings.Trim(strings.TrimPrefix(sql, "CREATE SCHEMA "), `"`)
		x.mu.Unlock()
		x.pending.Store(true)
	}
	if strings.HasPrefix(sql, "DROP SCHEMA ") && x.drop {
		x.mu.Lock()
		x.schema = strings.Trim(strings.TrimSuffix(strings.TrimPrefix(sql, "DROP SCHEMA "), " CASCADE"), `"`)
		x.mu.Unlock()
		x.pending.Store(true)
	}
	if strings.HasPrefix(sql, "INSERT INTO ") && strings.Contains(sql, "__webhook_fixture_owner") && len(q.Args) > 0 {
		x.mu.Lock()
		x.owner = fmt.Sprint(q.Args[0])
		x.mu.Unlock()
	}
	if strings.EqualFold(sql, "commit") && x.pending.Swap(false) && !x.lost.Load() {
		x.armed.Store(true)
	}
	return ctx
}
func (*schemaLossTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

type schemaLossConn struct {
	net.Conn
	trace  *schemaLossTracer
	buffer []byte
}

func (c *schemaLossConn) Read(p []byte) (int, error) {
	if len(c.buffer) > 0 {
		n := copy(p, c.buffer)
		c.buffer = c.buffer[n:]
		return n, nil
	}
	var hdr [5]byte
	if _, err := io.ReadFull(c.Conn, hdr[:]); err != nil {
		return 0, err
	}
	n := int(binary.BigEndian.Uint32(hdr[1:]))
	if n < 4 || n > 1<<20 {
		return 0, errors.New("invalid PostgreSQL frame")
	}
	payload := make([]byte, n-4)
	if _, err := io.ReadFull(c.Conn, payload); err != nil {
		return 0, err
	}
	if hdr[0] == 'C' && bytes.Equal(payload, []byte("COMMIT\x00")) && c.trace.armed.CompareAndSwap(true, false) {
		// Consume ReadyForQuery so PostgreSQL has completed transaction cleanup
		// before independently observing committed catalog state.
		for {
			if _, err := io.ReadFull(c.Conn, hdr[:]); err != nil {
				return 0, err
			}
			length := int(binary.BigEndian.Uint32(hdr[1:]))
			if length < 4 || length > 1<<20 {
				return 0, errors.New("invalid PostgreSQL frame")
			}
			frame := make([]byte, length-4)
			if _, err := io.ReadFull(c.Conn, frame); err != nil {
				return 0, err
			}
			if hdr[0] == 'Z' {
				break
			}
		}
		c.trace.mu.Lock()
		schema, owner := c.trace.schema, c.trace.owner
		c.trace.mu.Unlock()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		var got string
		var err error
		confirmed := false
		if c.trace.drop {
			var exists bool
			err = c.trace.verify.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, schema).Scan(&exists)
			confirmed = err == nil && !exists
		} else {
			err = c.trace.verify.QueryRow(ctx, "SELECT owner_id::text FROM "+pgx.Identifier{schema, "__webhook_fixture_owner"}.Sanitize()).Scan(&got)
			confirmed = err == nil && got == owner
		}
		c.trace.mu.Lock()
		c.trace.diag = fmt.Sprintf("query error=%v owner_input_present=%t actual_present=%t matched=%t schema_present=%t queries=%v", err, owner != "", got != "", got == owner, schema != "", c.trace.queries)
		c.trace.mu.Unlock()
		c.trace.committed.Store(confirmed)
		c.trace.lost.Store(true)
		_ = c.Conn.Close()
		return 0, io.EOF
	}
	c.buffer = append(hdr[:], payload...)
	n = copy(p, c.buffer)
	c.buffer = c.buffer[n:]
	return n, nil
}
func TestSchemaCommitReplyLostCleansOnlyOwnedSchema(t *testing.T) {
	dbURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	verify, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}

	foreign := "webhook_fixture_foreign_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = verify.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{foreign}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		c, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = verify.Exec(c, "DROP SCHEMA IF EXISTS "+pgx.Identifier{foreign}.Sanitize()+" CASCADE")
		verify.Close()
	})
	trace := &schemaLossTracer{verify: verify}
	newAdmin := func(ctx context.Context, raw string) (*pgxpool.Pool, error) {
		cfg, e := pgxpool.ParseConfig(raw)
		if e != nil {
			return nil, e
		}
		cfg.MaxConns = 1
		cfg.ConnConfig.TLSConfig = nil
		cfg.ConnConfig.Fallbacks = nil
		cfg.ConnConfig.Tracer = trace
		cfg.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
			c, e := (&net.Dialer{}).DialContext(ctx, network, address)
			if e != nil {
				return nil, e
			}
			return &schemaLossConn{Conn: c, trace: trace}, nil
		}
		return pgxpool.NewWithConfig(ctx, cfg)
	}
	_, err = startWithAdmin(ctx, dbURL, secret.Random("dnst_"), secret.Random("dnpat_"), secret.Random("dnst_"), secret.Random("dnpat_"), postgres.Open, newAdmin)
	if err == nil || !trace.lost.Load() || !trace.committed.Load() {
		trace.mu.Lock()
		diag := trace.diag
		trace.mu.Unlock()
		t.Fatalf("lost=%t committed=%t error=%v %s", trace.lost.Load(), trace.committed.Load(), err, diag)
	}
	trace.mu.Lock()
	schema := trace.schema
	trace.mu.Unlock()
	var ours, other bool
	if err = verify.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1),EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$2)`, schema, foreign).Scan(&ours, &other); err != nil || ours || !other {
		t.Fatalf("owned remains=%t foreign remains=%t err=%v", ours, other, err)
	}
}

func TestDropSchemaRejectsForeignMarker(t *testing.T) {
	dbURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	schema := "webhook_fixture_foreign_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if _, err = pool.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() {
		c, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = pool.Exec(c, "DROP SCHEMA IF EXISTS "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
	}()
	marker := pgx.Identifier{schema, "__webhook_fixture_owner"}.Sanitize()
	if _, err = pool.Exec(ctx, "CREATE TABLE "+marker+" (owner_id uuid PRIMARY KEY)"); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, "INSERT INTO "+marker+" VALUES($1)", uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	f := &fixture{admin: pool, schema: schema, schemaCreated: true, schemaOwner: uuid.NewString()}
	if err = f.dropSchema(ctx); err == nil {
		t.Fatal("foreign schema was accepted")
	}
	var exists bool
	if err = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, schema).Scan(&exists); err != nil || !exists {
		t.Fatalf("foreign schema remains=%t err=%v", exists, err)
	}
}

func TestDropCommitReplyLostObservesAbsentSchema(t *testing.T) {
	dbURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
	if dbURL == "" {
		t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	verify, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer verify.Close()
	trace := &schemaLossTracer{verify: verify, drop: true}
	cfg, err := pgxpool.ParseConfig(dbURL)
	if err != nil {
		t.Fatal(err)
	}
	cfg.MaxConns = 1
	cfg.ConnConfig.TLSConfig = nil
	cfg.ConnConfig.Fallbacks = nil
	cfg.ConnConfig.Tracer = trace
	cfg.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
		c, e := (&net.Dialer{}).DialContext(ctx, network, address)
		if e != nil {
			return nil, e
		}
		return &schemaLossConn{Conn: c, trace: trace}, nil
	}
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	f := &fixture{admin: pool, schema: "webhook_fixture_" + strings.ReplaceAll(uuid.NewString(), "-", ""), schemaOwner: uuid.NewString()}
	if err = f.createSchema(ctx); err != nil {
		t.Fatal(err)
	}
	defer func() {
		c, stop := context.WithTimeout(context.Background(), 5*time.Second)
		defer stop()
		_, _ = verify.Exec(c, "DROP SCHEMA IF EXISTS "+pgx.Identifier{f.schema}.Sanitize()+" CASCADE")
	}()
	if err = f.dropSchema(ctx); err != nil || !trace.lost.Load() || !trace.committed.Load() {
		t.Fatalf("drop reconciliation err=%v lost=%t committed=%t", err, trace.lost.Load(), trace.committed.Load())
	}
	var exists bool
	if err = verify.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, f.schema).Scan(&exists); err != nil || exists {
		t.Fatalf("schema remains=%t err=%v", exists, err)
	}
}

type rollbackStallTracer struct {
	armed, stalled, observed atomic.Bool
	verify                   *pgxpool.Pool
	schema                   string
	expectPresent            bool
}

func (x *rollbackStallTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, q pgx.TraceQueryStartData) context.Context {
	if strings.EqualFold(strings.TrimSpace(q.SQL), "rollback") {
		x.armed.Store(true)
	}
	return ctx
}
func (*rollbackStallTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

type rollbackStallConn struct {
	net.Conn
	trace  *rollbackStallTracer
	buffer []byte
}

func (c *rollbackStallConn) Read(p []byte) (int, error) {
	if len(c.buffer) > 0 {
		n := copy(p, c.buffer)
		c.buffer = c.buffer[n:]
		return n, nil
	}
	var hdr [5]byte
	if _, err := io.ReadFull(c.Conn, hdr[:]); err != nil {
		return 0, err
	}
	n := int(binary.BigEndian.Uint32(hdr[1:]))
	if n < 4 || n > 1<<20 {
		return 0, errors.New("invalid PostgreSQL frame")
	}
	payload := make([]byte, n-4)
	if _, err := io.ReadFull(c.Conn, payload); err != nil {
		return 0, err
	}
	if hdr[0] == 'C' && bytes.Equal(payload, []byte("ROLLBACK\x00")) && c.trace.armed.CompareAndSwap(true, false) {
		for {
			if _, err := io.ReadFull(c.Conn, hdr[:]); err != nil {
				return 0, err
			}
			size := int(binary.BigEndian.Uint32(hdr[1:]))
			if size < 4 || size > 1<<20 {
				return 0, errors.New("invalid PostgreSQL frame")
			}
			frame := make([]byte, size-4)
			if _, err := io.ReadFull(c.Conn, frame); err != nil {
				return 0, err
			}
			if hdr[0] == 'Z' {
				break
			}
		}
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		var exists bool
		err := c.trace.verify.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, c.trace.schema).Scan(&exists)
		cancel()
		c.trace.observed.Store(err == nil && exists == c.trace.expectPresent)
		c.trace.stalled.Store(true)
		// The actual ROLLBACK and ReadyForQuery are withheld. The socket remains
		// idle until the client's rollback context expires and closes the connection.
		return c.Conn.Read(p)
	}
	c.buffer = append(hdr[:], payload...)
	n = copy(p, c.buffer)
	c.buffer = c.buffer[n:]
	return n, nil
}
func TestRollbackReplyStallIsBounded(t *testing.T) {
	for _, kind := range []string{"create", "drop"} {
		t.Run(kind, func(t *testing.T) {
			dbURL := os.Getenv("DAYNIGHT_TEST_DATABASE_URL")
			if dbURL == "" {
				t.Fatal("DAYNIGHT_TEST_DATABASE_URL is required")
			}
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			verify, err := pgxpool.New(ctx, dbURL)
			if err != nil {
				t.Fatal(err)
			}
			defer verify.Close()
			schema := "webhook_fixture_" + strings.ReplaceAll(uuid.NewString(), "-", "")
			if kind == "drop" {
				if _, err = verify.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
					t.Fatal(err)
				}
				defer func() {
					c, stop := context.WithTimeout(context.Background(), 5*time.Second)
					defer stop()
					_, _ = verify.Exec(c, "DROP SCHEMA IF EXISTS "+pgx.Identifier{schema}.Sanitize()+" CASCADE")
				}()
				marker := pgx.Identifier{schema, "__webhook_fixture_owner"}.Sanitize()
				if _, err = verify.Exec(ctx, "CREATE TABLE "+marker+" (owner_id uuid PRIMARY KEY)"); err != nil {
					t.Fatal(err)
				}
				if _, err = verify.Exec(ctx, "INSERT INTO "+marker+" VALUES($1)", uuid.NewString()); err != nil {
					t.Fatal(err)
				}
			}
			trace := &rollbackStallTracer{verify: verify, schema: schema, expectPresent: kind == "drop"}
			cfg, err := pgxpool.ParseConfig(dbURL)
			if err != nil {
				t.Fatal(err)
			}
			cfg.MaxConns = 1
			cfg.ConnConfig.TLSConfig = nil
			cfg.ConnConfig.Fallbacks = nil
			cfg.ConnConfig.Tracer = trace
			cfg.ConnConfig.DialFunc = func(ctx context.Context, network, address string) (net.Conn, error) {
				c, e := (&net.Dialer{}).DialContext(ctx, network, address)
				if e != nil {
					return nil, e
				}
				return &rollbackStallConn{Conn: c, trace: trace}, nil
			}
			pool, err := pgxpool.NewWithConfig(ctx, cfg)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			f := &fixture{admin: pool, schema: schema, schemaOwner: "not-a-uuid", schemaCreated: kind == "drop"}
			started := time.Now()
			if kind == "create" {
				err = f.createSchema(ctx)
			} else {
				err = f.dropSchema(ctx)
			}
			elapsed := time.Since(started)
			var issue *schemaIssue
			if err == nil || !errors.As(err, &issue) || !errors.Is(err, context.DeadlineExceeded) || !trace.stalled.Load() || !trace.observed.Load() || elapsed < time.Second || elapsed > 5*time.Second {
				t.Fatalf("kind=%s err=%v stalled=%t observed=%t elapsed=%s", kind, err, trace.stalled.Load(), trace.observed.Load(), elapsed)
			}
			var exists bool
			if err = verify.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1)`, schema).Scan(&exists); err != nil || exists != (kind == "drop") {
				t.Fatalf("kind=%s exists=%t err=%v", kind, exists, err)
			}
		})
	}
}
