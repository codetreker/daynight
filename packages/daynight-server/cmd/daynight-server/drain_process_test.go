//go:build startupshutdown

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"os/exec"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/testdata/testauth"
	"github.com/jackc/pgx/v5"
)

func TestServerProcessDrainWritesAndLogs(t *testing.T) {
	for _, forced := range []bool{false, true} {
		t.Run(map[bool]string{false: "graceful", true: "deadline"}[forced], func(t *testing.T) {
			values := processAPIEnvironment(t)
			gateway := testauth.StartGateway(t, values["DAYNIGHT_UNIAUTH_CALLBACK_URL"])
			values["DAYNIGHT_UNIAUTH_URL"], values["DAYNIGHT_UNIAUTH_APP_ID"], values["DAYNIGHT_UNIAUTH_APP_SECRET"] = gateway.Origin, gateway.AppID, gateway.AppSecret
			values["DAYNIGHT_SHUTDOWN_TIMEOUT"] = "10s"
			if forced {
				values["DAYNIGHT_SHUTDOWN_TIMEOUT"] = "500ms"
			}
			adminURL := values["DAYNIGHT_DATABASE_URL"]
			parsed, err := url.Parse(adminURL)
			if err != nil {
				t.Fatal(err)
			}
			application := "drain_" + strings.ToLower(rand.Text())
			query := parsed.Query()
			query.Set("application_name", application)
			parsed.RawQuery = query.Encode()
			values["DAYNIGHT_DATABASE_URL"] = parsed.String()
			process := startPersistenceProcess(t, values)
			var processRoot string
			for _, entry := range process.cmd.Env {
				if strings.HasPrefix(entry, "DAYNIGHT_TEST_ROOT=") {
					processRoot = strings.TrimPrefix(entry, "DAYNIGHT_TEST_ROOT=")
				}
			}
			if processRoot == "" {
				t.Fatal("server process root is missing")
			}
			browser := testauth.Browser(t)
			testauth.Login(t, browser, values["DAYNIGHT_PUBLIC_ORIGIN"], "alice")
			token := testauth.CreatePAT(t, browser, values["DAYNIGHT_PUBLIC_ORIGIN"])
			browser.CloseIdleConnections()
			client := &http.Client{Timeout: 15 * time.Second, Transport: bearerTransport{token: token, next: http.DefaultTransport}}
			defer client.CloseIdleConnections()
			request := func(method, path string, input any) []byte {
				t.Helper()
				var body []byte
				if input != nil {
					var err error
					body, err = json.Marshal(input)
					if err != nil {
						t.Fatal(err)
					}
				}
				req, err := http.NewRequest(method, values["DAYNIGHT_PUBLIC_ORIGIN"]+path, bytes.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				if input != nil {
					req.Header.Set("Content-Type", "application/json")
				}
				response, err := client.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				data, readErr := io.ReadAll(response.Body)
				closeErr := response.Body.Close()
				if readErr != nil || closeErr != nil || response.StatusCode/100 != 2 {
					t.Fatalf("setup/read response: status=%d read=%v close=%v", response.StatusCode, readErr, closeErr)
				}
				return data
			}
			var user api.User
			if err := json.Unmarshal(request("GET", "/api/v1/me", nil), &user); err != nil {
				t.Fatal(err)
			}
			var project api.Project
			if err := json.Unmarshal(request("POST", "/api/v1/projects", api.CreateProjectRequest{Name: "Drain", RepoURL: "https://example.test/drain", ExpectedUserID: user.ID}), &project); err != nil {
				t.Fatal(err)
			}
			var before api.Task
			if err := json.Unmarshal(request("POST", "/api/v1/projects/"+project.ID+"/tasks", map[string]any{"title": "Before drain"}), &before); err != nil {
				t.Fatal(err)
			}
			path := "/api/v1/projects/" + project.ID + "/tasks/" + before.ID
			ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
			defer cancel()
			observer, err := pgx.Connect(ctx, adminURL)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
				defer done()
				if err := observer.Close(cleanup); err != nil {
					t.Error(err)
				}
			})
			lock, err := observer.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			held := true
			t.Cleanup(func() {
				if held {
					cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
					defer done()
					if err := lock.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
						t.Error(err)
					}
				}
			})
			if _, err := lock.Exec(ctx, `SELECT id FROM projects WHERE id=$1 FOR UPDATE`, project.ID); err != nil {
				t.Fatal(err)
			}
			requestContext, stopRequest := context.WithCancel(context.Background())
			done := make(chan struct{})
			t.Cleanup(func() {
				stopRequest()
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Error("pending HTTP request did not exit")
				}
			})
			type result struct {
				status int
				body   []byte
				err    error
			}
			resultChannel := make(chan result, 1)
			input, err := json.Marshal(map[string]any{"version": before.Version, "title": "Drained change"})
			if err != nil {
				t.Fatal(err)
			}
			go func() {
				defer close(done)
				req, err := http.NewRequestWithContext(requestContext, http.MethodPatch, values["DAYNIGHT_PUBLIC_ORIGIN"]+path, bytes.NewReader(input))
				if err != nil {
					resultChannel <- result{err: err}
					return
				}
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("X-Request-ID", "controlled-drain")
				response, err := client.Do(req)
				if err != nil {
					resultChannel <- result{err: err}
					return
				}
				data, readErr := io.ReadAll(response.Body)
				closeErr := response.Body.Close()
				resultChannel <- result{status: response.StatusCode, body: data, err: errors.Join(readErr, closeErr)}
			}()
			ticker := time.NewTicker(10 * time.Millisecond)
			defer ticker.Stop()
			for {
				if _, err := lock.Exec(ctx, `SELECT pg_stat_clear_snapshot()`); err != nil {
					t.Fatal(err)
				}
				var waiting bool
				if err := lock.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock' AND query LIKE 'SELECT id::text FROM projects WHERE id = % FOR UPDATE')`, application).Scan(&waiting); err != nil {
					t.Fatal(err)
				}
				if waiting {
					break
				}
				select {
				case got := <-resultChannel:
					t.Fatalf("request ended before project lock wait: status=%d error=%v", got.status, got.err)
				case <-ctx.Done():
					t.Fatal("request never reached project lock")
				case <-ticker.C:
				}
			}
			if err := process.cmd.Process.Signal(syscall.SIGTERM); err != nil {
				t.Fatal(err)
			}
			if !forced {
				for {
					connection, err := net.DialTimeout("tcp", values["DAYNIGHT_LISTEN_ADDR"], 100*time.Millisecond)
					if err != nil {
						break
					}
					_ = connection.Close()
					select {
					case <-ctx.Done():
						t.Fatal("listener did not close during graceful drain")
					case <-ticker.C:
					}
				}
				select {
				case got := <-resultChannel:
					t.Fatalf("write finished before lock release: status=%d error=%v", got.status, got.err)
				default:
				}
				contender := startLoggingProcess(t, processRoot, "server", values)
				if err := contender.wait(t); err == nil || !strings.Contains(contender.logs.String(), `"phase":"lock"`) || !strings.Contains(contender.logs.String(), `"cause":"busy"`) {
					t.Fatalf("draining process did not retain its log lock: %v; %s", err, contender.logs.String())
				}
				select {
				case got := <-resultChannel:
					t.Fatalf("write finished before lock release: status=%d error=%v", got.status, got.err)
				default:
				}
				if err := lock.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				held = false
			}
			var write result
			select {
			case write = <-resultChannel:
			case <-ctx.Done():
				t.Fatal("HTTP request did not finish during drain")
			}
			var processErr error
			select {
			case processErr = <-process.finished:
				process.stopped = true
			case <-ctx.Done():
				t.Fatal("service did not finish shutdown")
			}
			if forced {
				var exit *exec.ExitError
				if !errors.As(processErr, &exit) || exit.ExitCode() != 1 || write.err == nil && write.status < 500 {
					t.Fatalf("deadline shutdown: exit=%v status=%d error=%v", processErr, write.status, write.err)
				}
			} else {
				if processErr != nil || write.err != nil || write.status != http.StatusOK {
					t.Fatalf("graceful shutdown: exit=%v status=%d error=%v", processErr, write.status, write.err)
				}
				var after api.Task
				if err := json.Unmarshal(write.body, &after); err != nil || after.Title != "Drained change" || after.Version != before.Version+1 {
					t.Fatalf("drained write receipt: %+v %v", after, err)
				}
				before = after
				reacquired := startLoggingProcess(t, processRoot, "server", values)
				reacquired.ready(t, values["DAYNIGHT_PUBLIC_ORIGIN"])
				if err := reacquired.cmd.Process.Signal(syscall.SIGTERM); err != nil {
					t.Fatal(err)
				}
				if err := reacquired.wait(t); err != nil {
					t.Fatalf("reacquired process did not stop cleanly: %v; %s", err, reacquired.logs.String())
				}
			}
			var stopped, canceled, deadline bool
			for _, line := range strings.Split(strings.TrimSpace(process.logs.String()), "\n") {
				var event map[string]any
				if err := json.Unmarshal([]byte(line), &event); err != nil {
					continue
				}
				stopped = stopped || event["phase"] == "stopped"
				canceled = canceled || event["component"] == "task" && event["phase"] == "update" && event["request_id"] == "controlled-drain" && event["cause"] == "canceled"
				deadline = deadline || event["component"] == "server" && event["phase"] == "shutdown" && event["cause"] == "deadline"
			}
			if strings.Contains(process.logs.String(), token) || forced && (!canceled || !deadline) || !forced && !stopped {
				t.Fatalf("shutdown diagnostic missing or unsafe: stopped=%t canceled=%t deadline=%t", stopped, canceled, deadline)
			}
			if held {
				if err := lock.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				held = false
			}
			process = startPersistenceProcess(t, values)
			var recovered api.Task
			if err := json.Unmarshal(request("GET", path, nil), &recovered); err != nil || !reflect.DeepEqual(recovered, before) {
				t.Fatalf("task changed across shutdown and restart: %+v %v", recovered, err)
			}
			if err := process.stop(); err != nil {
				t.Fatalf("restarted service did not stop cleanly: %v", err)
			}
		})
	}
}
