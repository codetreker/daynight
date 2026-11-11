//go:build startupshutdown

package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/logging"
)

func TestLoggingProcessHelper(t *testing.T) {
	mode := os.Getenv("DAYNIGHT_LOGGING_PROCESS_HELPER")
	if mode == "" {
		return
	}
	args := []string{"--root", os.Getenv("DAYNIGHT_TEST_ROOT")}
	if mode == "verify" {
		args = append([]string{"verify-storage"}, args...)
	}
	var stderr io.Writer = os.Stderr
	if mode == "signal_stderr_failure" {
		stderr = &signalFailureStderr{}
	}
	os.Exit(run(context.Background(), args, os.LookupEnv, stderr))
}

type loggingProcess struct {
	cmd      *exec.Cmd
	finished chan error
	logs     *persistenceProcessLog
	root     string
	stdin    io.WriteCloser
	reaped   bool
}

func startLoggingProcess(t *testing.T, root, mode string, values map[string]string) *loggingProcess {
	t.Helper()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(executable, "-test.run=^TestLoggingProcessHelper$")
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if !strings.HasPrefix(key, "DAYNIGHT_") {
			cmd.Env = append(cmd.Env, entry)
		}
	}
	for key, value := range values {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	cmd.Env = append(cmd.Env, "DAYNIGHT_LOGGING_PROCESS_HELPER="+mode, "DAYNIGHT_TEST_ROOT="+root)
	var stdin io.WriteCloser
	if mode == "signal_stderr_failure" {
		stdin, err = cmd.StdinPipe()
		if err != nil {
			t.Fatal(err)
		}
	}
	logs := &persistenceProcessLog{}
	cmd.Stdout, cmd.Stderr = logs, logs
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	p := &loggingProcess{cmd: cmd, finished: make(chan error, 1), logs: logs, root: root, stdin: stdin}
	go func() { p.finished <- cmd.Wait() }()
	t.Cleanup(func() {
		if !p.reaped {
			_ = p.cmd.Process.Kill()
			select {
			case <-p.finished:
				p.reaped = true
			case <-time.After(5 * time.Second):
				t.Error("logging process was not reaped")
			}
		}
	})
	return p
}

func (p *loggingProcess) wait(t *testing.T) error {
	t.Helper()
	select {
	case err := <-p.finished:
		p.reaped = true
		return err
	case <-time.After(20 * time.Second):
		t.Fatal("logging process did not exit", p.logs.String())
		return nil
	}
}

func (p *loggingProcess) ready(t *testing.T, origin string) {
	t.Helper()
	client := &http.Client{Timeout: time.Second}
	defer client.CloseIdleConnections()
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for {
		request, err := http.NewRequest(http.MethodGet, origin+"/readyz", nil)
		if err != nil {
			t.Fatal(err)
		}
		id := rand.Text()
		request.Header.Set("X-Request-ID", id)
		response, err := client.Do(request)
		if err == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
			if response.StatusCode == http.StatusOK {
				for {
					data, err := os.ReadFile(filepath.Join(p.root, "logs", "daynight-server.log"))
					if err == nil && bytes.Contains(data, []byte(id)) {
						return
					}
					select {
					case <-deadline.C:
						t.Fatal("ready request was not recorded", p.logs.String())
					case <-ticker.C:
					}
				}
			}
		}
		select {
		case err := <-p.finished:
			p.reaped = true
			t.Fatalf("logging process exited before readiness: %v; %s", err, p.logs.String())
		case <-deadline.C:
			t.Fatalf("logging process did not become ready: %s", p.logs.String())
		case <-ticker.C:
		}
	}
}

func loggingBytes(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestLoggingProcessLockAndRecovery(t *testing.T) {
	root := testStorageRoot(t)
	values := processAPIEnvironment(t)
	logsDir := filepath.Join(root, "logs")
	if err := os.Mkdir(logsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	active, archive := filepath.Join(logsDir, "daynight-server.log"), filepath.Join(logsDir, "daynight-server.log.1")
	if err := os.WriteFile(archive, []byte("archive sentinel\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	first := startLoggingProcess(t, root, "server", values)
	first.ready(t, values["DAYNIGHT_PUBLIC_ORIGIN"])
	before, archiveBefore := loggingBytes(t, active), loggingBytes(t, archive)
	second := startLoggingProcess(t, root, "server", values)
	if err := second.wait(t); err == nil {
		t.Fatal("second process acquired an occupied log lock")
	}
	if !strings.Contains(second.logs.String(), `"phase":"lock"`) || !strings.Contains(second.logs.String(), `"event":"logging_failed"`) {
		t.Fatalf("missing lock failure: %s", second.logs.String())
	}
	after := loggingBytes(t, active)
	if !bytes.HasPrefix(after, before) {
		t.Fatal("contending process replaced or truncated active log")
	}
	for _, line := range bytes.Split(bytes.TrimSpace(after), []byte("\n")) {
		var entry struct {
			PID int `json:"pid"`
		}
		if err := json.Unmarshal(line, &entry); err != nil || entry.PID != first.cmd.Process.Pid {
			t.Fatalf("active log contains a record from another process: %s", line)
		}
	}
	if after := loggingBytes(t, archive); !bytes.Equal(archiveBefore, after) {
		t.Fatal("contending process changed archive")
	}
	first.ready(t, values["DAYNIGHT_PUBLIC_ORIGIN"])
	if err := first.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if err := first.wait(t); err != nil {
		t.Fatalf("first process did not exit cleanly: %v; %s", err, first.logs.String())
	}
	if after := loggingBytes(t, active); len(after) <= len(before) || !bytes.HasPrefix(after, before) {
		t.Fatal("first process did not continue writing after contention")
	}
	third := startLoggingProcess(t, root, "server", values)
	third.ready(t, values["DAYNIGHT_PUBLIC_ORIGIN"])
	if err := third.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := third.wait(t); err == nil {
		t.Fatal("killed process exited successfully")
	}
	fourth := startLoggingProcess(t, root, "server", values)
	fourth.ready(t, values["DAYNIGHT_PUBLIC_ORIGIN"])
	if err := fourth.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if err := fourth.wait(t); err != nil {
		t.Fatalf("process could not shut down after lock recovery: %v; %s", err, fourth.logs.String())
	}
}

func TestLoggingProcessConfigurationFailureAndVerifyBoundary(t *testing.T) {
	root := filepath.Join(testStorageRoot(t), "secret-root-marker")
	if err := os.MkdirAll(filepath.Join(root, "config"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "config", "config.yml"), []byte("database:\n  url: [sensitive-yaml-marker\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	server := startLoggingProcess(t, root, "server", nil)
	if err := server.wait(t); err == nil {
		t.Fatal("invalid configuration was accepted")
	}
	file := loggingBytes(t, filepath.Join(root, "logs", "daynight-server.log"))
	stderr := []byte(server.logs.String())
	if !bytes.Equal(file, stderr) {
		t.Fatalf("configuration diagnostic differs between sinks: file=%q stderr=%q", file, stderr)
	}
	var event struct {
		RunID     string `json:"run_id"`
		PID       int    `json:"pid"`
		Command   string `json:"command"`
		Component string `json:"component"`
		Phase     string `json:"phase"`
	}
	if err := json.Unmarshal(file, &event); err != nil || !regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(event.RunID) || event.PID != server.cmd.Process.Pid || event.Command != "server" || event.Component != "configuration" || event.Phase != "decode" {
		t.Fatalf("invalid configuration diagnostic: %s", file)
	}
	if bytes.Contains(file, []byte("secret-root-marker")) || bytes.Contains(file, []byte("sensitive-yaml-marker")) {
		t.Fatal("configuration diagnostic exposed private data")
	}
	verifyRoot := filepath.Join(testStorageRoot(t), "verify")
	if err := os.MkdirAll(filepath.Join(verifyRoot, "config"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(verifyRoot, "config", "config.yml"), []byte("database:\n  url: [sensitive-yaml-marker\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	verify := startLoggingProcess(t, verifyRoot, "verify", nil)
	if err := verify.wait(t); err == nil {
		t.Fatal("verifier accepted invalid configuration")
	}
	if strings.Contains(verify.logs.String(), "sensitive-yaml-marker") {
		t.Fatal("verifier exposed private configuration")
	}
	if _, err := os.Stat(filepath.Join(verifyRoot, "logs")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("verifier created or could not inspect logs directory: %v", err)
	}
}

// failingStartupStderr cancels before reporting the first write error when
// requested, modeling a signal racing with a logging failure.
type failingStartupStderr struct {
	cancel context.CancelFunc
	failed bool
	output bytes.Buffer
}

func (w *failingStartupStderr) Write(value []byte) (int, error) {
	if !w.failed {
		w.failed = true
		if w.cancel != nil {
			w.cancel()
		}
		return 0, errors.New("private-stderr-failure-marker")
	}
	return w.output.Write(value)
}

func TestLoggingStartupFailureStopsBeforeDatabaseAndSurvivesCancellation(t *testing.T) {
	for _, cancelFirst := range []bool{false, true} {
		name := "write failure"
		if cancelFirst {
			name = "cancellation before write failure"
		}
		t.Run(name, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			root := filepath.Join(testStorageRoot(t), "private-root-marker")
			values := testEnvironment(t)
			values["DAYNIGHT_DATABASE_URL"] = "postgres://private-user:private-password@" + listener.Addr().String() + "/daynight?sslmode=disable"
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			stderr := &failingStartupStderr{}
			if cancelFirst {
				stderr.cancel = cancel
			}
			if code := run(ctx, []string{"--root", root}, lookupTestEnvironment(values), stderr); code != 1 {
				t.Fatalf("startup logging failure returned %d", code)
			}
			if err := listener.(*net.TCPListener).SetDeadline(time.Now().Add(150 * time.Millisecond)); err != nil {
				t.Fatal(err)
			}
			connection, err := listener.Accept()
			if err == nil {
				connection.Close()
				t.Fatal("database was contacted after the startup logging failure")
			}
			if timeout, ok := err.(net.Error); !ok || !timeout.Timeout() {
				t.Fatalf("database connection observation failed: %v", err)
			}
			file := loggingBytes(t, filepath.Join(root, "logs", "daynight-server.log"))
			var startup, failure struct {
				RunID    string `json:"run_id"`
				Event    string `json:"event"`
				Phase    string `json:"phase"`
				Sink     string `json:"sink"`
				Resource string `json:"resource"`
			}
			if err := json.Unmarshal(file, &startup); err != nil || startup.Event != "configuration_loaded" {
				t.Fatalf("file did not receive startup record after stderr failure: %s", file)
			}
			if err := json.Unmarshal(stderr.output.Bytes(), &failure); err != nil || failure.Event != "logging_failed" || failure.Phase != "write" || failure.Sink != "stderr" || failure.Resource != "stderr" || startup.RunID == "" || startup.RunID != failure.RunID {
				t.Fatalf("invalid logging failure diagnostic: %s", stderr.output.String())
			}
			for _, secret := range []string{"private-root-marker", "private-stderr-failure-marker", "private-user", "private-password"} {
				if bytes.Contains(file, []byte(secret)) || bytes.Contains(stderr.output.Bytes(), []byte(secret)) {
					t.Fatalf("logging failure exposed %s", secret)
				}
			}
		})
	}
}

func TestLoggingFailureAggregateReportsSafeComponents(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil)).With("run_id", "same-run", "pid", 123, "command", "server")
	joined := errors.Join(
		fmt.Errorf("private-wrapper-marker: %w", &logging.Error{Phase: "write", Sink: "stderr", Resource: "stderr", Cause: "io"}),
		errors.Join(errors.New("private-unknown-marker"), &logging.Error{Phase: "close", Sink: "file", Resource: "daynight-server.log", Cause: "no_space"}),
	)
	logLoggingFailure(logger, context.Background(), joined)
	lines := bytes.Split(bytes.TrimSpace(output.Bytes()), []byte("\n"))
	if len(lines) != 2 {
		t.Fatalf("aggregate produced %d diagnostics: %s", len(lines), output.String())
	}
	for index, expected := range []struct{ phase, sink, resource, cause string }{
		{"write", "stderr", "stderr", "io"},
		{"close", "file", "daynight-server.log", "no_space"},
	} {
		var event struct {
			RunID     string `json:"run_id"`
			PID       int    `json:"pid"`
			Command   string `json:"command"`
			Event     string `json:"event"`
			Type      string `json:"type"`
			Component string `json:"component"`
			Phase     string `json:"phase"`
			Sink      string `json:"sink"`
			Resource  string `json:"resource"`
			ErrorCode string `json:"error_code"`
			Cause     string `json:"cause"`
		}
		if err := json.Unmarshal(lines[index], &event); err != nil || event.RunID != "same-run" || event.PID != 123 || event.Command != "server" || event.Event != "logging_failed" || event.Type != "operation_error" || event.Component != "logging" || event.Phase != expected.phase || event.Sink != expected.sink || event.Resource != expected.resource || event.ErrorCode != "logging_failed" || event.Cause != expected.cause {
			t.Fatalf("aggregate diagnostic %d: %s", index, lines[index])
		}
	}
	if strings.Contains(output.String(), "private-") {
		t.Fatal("aggregate diagnostic exposed raw error")
	}
}

// signalFailureStderr gates the stopped record until the parent has observed
// that SIGTERM initiated shutdown, then injects a single stderr failure.
type signalFailureStderr struct{ failed bool }

func (w *signalFailureStderr) Write(value []byte) (int, error) {
	if !w.failed && bytes.Contains(value, []byte(`"phase":"stopped"`)) {
		w.failed = true
		if _, err := os.Stderr.WriteString("stopped-write-blocked\n"); err != nil {
			return 0, err
		}
		if _, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil {
			return 0, err
		}
		return 0, errors.New("private-signal-write-marker")
	}
	return os.Stderr.Write(value)
}

func TestLoggingProcessSignalBeforeStoppedWriteFailure(t *testing.T) {
	root := testStorageRoot(t)
	values := processAPIEnvironment(t)
	process := startLoggingProcess(t, root, "signal_stderr_failure", values)
	process.ready(t, values["DAYNIGHT_PUBLIC_ORIGIN"])
	if err := process.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	deadline := time.NewTimer(20 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()
	for !strings.Contains(process.logs.String(), "stopped-write-blocked\n") {
		select {
		case err := <-process.finished:
			process.reaped = true
			t.Fatalf("process exited before stopped-write barrier: %v; %s", err, process.logs.String())
		case <-deadline.C:
			t.Fatal("process did not reach stopped-write barrier", process.logs.String())
		case <-ticker.C:
		}
	}
	if _, err := process.stdin.Write([]byte("continue\n")); err != nil {
		t.Fatal(err)
	}
	if err := process.wait(t); err == nil {
		t.Fatal("signal masked the later logging error")
	}
	output := process.logs.String()
	if !strings.Contains(output, `"event":"logging_failed"`) || !strings.Contains(output, `"phase":"write"`) || !strings.Contains(output, `"sink":"stderr"`) || strings.Contains(output, "private-signal-write-marker") {
		t.Fatalf("unsafe or missing logging failure: %s", output)
	}
	file := loggingBytes(t, filepath.Join(root, "logs", "daynight-server.log"))
	if !bytes.Contains(file, []byte(`"phase":"stopped"`)) || bytes.Contains(file, []byte("private-signal-write-marker")) {
		t.Fatalf("file did not retain the stopped record safely: %s", file)
	}
}
