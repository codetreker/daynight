//go:build startupshutdown

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"
)

type grantStartupEvidence struct {
	Readiness string            `json:"readiness"`
	Exit      grantExitEvidence `json:"exit"`
	Logs      grantLogEvidence  `json:"logs"`
}

type grantExitEvidence struct {
	Wait     string `json:"wait"`
	ExitCode *int   `json:"exitCode"`
	Signal   *int   `json:"signal"`
}

func (p *grantProcess) exitEvidence(started bool) grantExitEvidence {
	result := grantExitEvidence{Wait: "not_started"}
	if p == nil || !started {
		return result
	}
	result.Wait = "pending"
	select {
	case <-p.done:
	default:
		return result
	}
	// Wait publishes both its error and ProcessState before closing done.
	result.Wait = "other"
	var exitError *exec.ExitError
	switch {
	case p.err == nil:
		result.Wait = "success"
	case errors.As(p.err, &exitError):
		result.Wait = "exit"
	case errors.Is(p.err, exec.ErrWaitDelay):
		result.Wait = "wait_delay"
	}
	if state := p.command.ProcessState; state != nil {
		if code := state.ExitCode(); code >= 0 {
			result.ExitCode = &code
		}
		if status, ok := state.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			signal := int(status.Signal())
			result.Signal = &signal
		}
	}
	return result
}

func grantReadiness(ctx context.Context, done <-chan struct{}, check func() bool) string {
	exited := errors.New("service exited before readiness")
	err := grantWait(ctx, func() (bool, error) {
		select {
		case <-done:
			return false, exited
		default:
			return check(), nil
		}
	})
	switch {
	case err == nil:
		return "ready"
	case errors.Is(err, exited):
		return "exited"
	case errors.Is(err, context.DeadlineExceeded):
		return "deadline"
	case errors.Is(err, context.Canceled):
		return "canceled"
	default:
		return "unknown"
	}
}

type grantFailureEvidence struct {
	Component string `json:"component"`
	Phase     string `json:"phase"`
	Cause     string `json:"cause"`
	Detail    string `json:"detail"`
}

type grantLogEvidence struct {
	Listening bool                   `json:"listening"`
	Failures  []grantFailureEvidence `json:"failures"`
	Ignored   bool                   `json:"ignored"`
	Truncated bool                   `json:"truncated"`
}

func (l *grantLogs) diagnostics() grantLogEvidence {
	const limit = 64 << 10
	l.mu.Lock()
	data := bytes.Clone(l.bytes.Bytes()[:min(l.bytes.Len(), limit)])
	result := grantLogEvidence{Truncated: l.bytes.Len() > limit}
	l.mu.Unlock()
	if result.Truncated {
		// A cut JSON record must not become evidence from a partial prefix.
		data = data[:bytes.LastIndexByte(data, '\n')+1]
	}
	for _, line := range bytes.Split(data, []byte{'\n'}) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var entry struct{ Type, Component, Phase, Cause, Diagnostic string }
		if json.Unmarshal(line, &entry) != nil {
			result.Ignored = true
			continue
		}
		if entry.Type == "lifecycle" && entry.Component == "server" && entry.Phase == "listening" {
			result.Listening = true
			continue
		}
		if entry.Type != "operation_error" || !(entry.Component == "configuration" && (entry.Phase == "arguments" || entry.Phase == "load") || entry.Component == "server" && (entry.Phase == "startup" || entry.Phase == "shutdown")) {
			result.Ignored = true
			continue
		}
		failure := grantFailureEvidence{Component: entry.Component, Phase: entry.Phase, Cause: "unknown", Detail: "unknown"}
		switch entry.Cause {
		case "canceled", "deadline", "database", "protocol", "network", "address_in_use", "internal":
			failure.Cause = entry.Cause
		}
		// Only fixed diagnostics emitted by the startup owners become detail codes.
		switch entry.Diagnostic {
		case "database configuration failed":
			failure.Detail = "database_configuration"
		case "database connect failed":
			failure.Detail = "database_connect"
		case "database migrate failed":
			failure.Detail = "database_migrate"
		case "database readiness failed":
			failure.Detail = "database_readiness"
		case "HTTP listen failed":
			failure.Detail = "http_listen"
		case "DAYNIGHT_STORAGE_ROOT must identify a writable storage directory with supported filename semantics":
			failure.Detail = "storage_configuration"
		}
		if len(result.Failures) < 4 {
			result.Failures = append(result.Failures, failure)
		} else {
			result.Truncated = true
		}
	}
	return result
}

func TestGrantReadinessOutcomes(t *testing.T) {
	for _, outcome := range []string{"ready", "exited", "deadline", "canceled"} {
		t.Run(outcome, func(t *testing.T) {
			done := make(chan struct{})
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			if outcome == "exited" {
				close(done)
			}
			if outcome == "deadline" {
				ctx, cancel = context.WithDeadline(t.Context(), time.Time{})
				defer cancel()
			}
			if outcome == "canceled" {
				cancel()
			}
			calls := 0
			actual := grantReadiness(ctx, done, func() bool { calls++; return outcome == "ready" })
			if actual != outcome || outcome == "exited" && calls != 0 {
				t.Fatalf("readiness=%s, polls=%d", actual, calls)
			}
		})
	}
	done := make(chan struct{})
	if result := grantReadiness(t.Context(), done, func() bool { close(done); return false }); result != "exited" {
		t.Fatal("exit during a failed poll became a deadline")
	}
}

func TestGrantDiagnosticsHideUntrustedOutputAndBoundEvidence(t *testing.T) {
	const failure = `{"type":"operation_error","component":"server","phase":"startup","cause":"address_in_use","diagnostic":"HTTP listen failed","address":"https://private-secret.example/?token=private-secret","message":"private-secret"}` + "\n"
	var logs grantLogs
	_, _ = logs.Write([]byte("panic: private-secret\n" + `{"type":"lifecycle","component":"server","phase":"listening","address":"private-secret"}` + "\n" + failure + `{"type":"operation_error","component":"server","phase":"startup","cause":"private-secret","diagnostic":"private-secret"}` + "\n" + `{"type":"operation_error","component":"private-secret","phase":"private-secret"}` + "\n"))
	first := logs.diagnostics()
	if !first.Listening || !first.Ignored || first.Truncated || len(first.Failures) != 2 || first.Failures[0].Cause != "address_in_use" || first.Failures[0].Detail != "http_listen" || first.Failures[1].Cause != "unknown" || first.Failures[1].Detail != "unknown" {
		t.Fatalf("missing safe classification: %+v", first)
	}
	_, _ = logs.Write([]byte(strings.Repeat(failure, 8) + strings.Repeat("padding", 10_000) + "late-only-secret"))
	bounded := logs.diagnostics()
	encoded, err := json.Marshal(bounded)
	if err != nil || len(encoded) > 1024 || bytes.Contains(encoded, []byte("private-secret")) || !bounded.Truncated || len(bounded.Failures) != 4 || !logs.contains("late-only-secret") {
		t.Fatal("diagnostics leaked, exceeded bounds, or weakened the private secret check")
	}
	var cut grantLogs
	_, _ = cut.Write([]byte(strings.TrimSuffix(failure, "\n") + strings.Repeat(" ", 64<<10) + "private-secret"))
	if value := cut.diagnostics(); !value.Truncated || len(value.Failures) != 0 {
		t.Fatal("a record outside the diagnostic window became evidence")
	}
}

func TestGrantDiagnosticsPreserveStartupOwnerDetails(t *testing.T) {
	for diagnostic, detail := range map[string]string{
		"database configuration failed": "database_configuration",
		"database connect failed":       "database_connect",
		"database migrate failed":       "database_migrate",
		"database readiness failed":     "database_readiness",
		"DAYNIGHT_STORAGE_ROOT must identify a writable storage directory with supported filename semantics": "storage_configuration",
	} {
		var logs grantLogs
		encoded, err := json.Marshal(map[string]string{"type": "operation_error", "component": "server", "phase": "startup", "cause": "internal", "diagnostic": diagnostic})
		if err != nil {
			t.Fatal("cannot encode controlled startup event")
		}
		_, _ = logs.Write(encoded)
		if result := logs.diagnostics(); len(result.Failures) != 1 || result.Failures[0].Detail != detail {
			t.Fatalf("startup detail was not preserved: %s", detail)
		}
	}
}

func TestGrantDiagnosticsProcessHelper(t *testing.T) {
	switch os.Getenv("DAYNIGHT_GRANT_DIAGNOSTICS_PROCESS_HELPER") {
	case "exit":
		fmt.Println("panic: private-secret")
		fmt.Println(`{"type":"operation_error","component":"server","phase":"startup","cause":"database","diagnostic":"database connect failed","message":"private-secret"}`)
		os.Exit(23)
	case "signal":
		process, err := os.FindProcess(os.Getpid())
		if err == nil {
			_ = process.Kill()
		}
		os.Exit(24)
	}
}

func TestGrantExitEvidenceWaitsForReapingAndPreservesFailure(t *testing.T) {
	pending := &grantProcess{done: make(chan struct{})}
	if value := pending.exitEvidence(true); value.Wait != "pending" || value.ExitCode != nil || value.Signal != nil {
		t.Fatal("unconfirmed exit acquired process facts")
	}
	if value := pending.exitEvidence(false); value.Wait != "not_started" {
		t.Fatal("unstarted process was reported as running")
	}
	for _, item := range []struct {
		failure error
		wait    string
	}{{exec.ErrWaitDelay, "wait_delay"}, {errors.New("private-secret"), "other"}} {
		finished := &grantProcess{command: &exec.Cmd{}, done: make(chan struct{}), err: item.failure}
		close(finished.done)
		if value := finished.exitEvidence(true); value.Wait != item.wait || value.ExitCode != nil || value.Signal != nil {
			t.Fatal("a Wait failure invented OS exit facts")
		}
	}
	for _, mode := range []string{"exit", "signal"} {
		t.Run(mode, func(t *testing.T) {
			executable, err := os.Executable()
			if err != nil {
				t.Fatal("cannot locate owned test executable")
			}
			process := &grantProcess{command: exec.Command(executable, "-test.run=^TestGrantDiagnosticsProcessHelper$"), done: make(chan struct{})}
			process.command.Env = grantEnvironment(map[string]string{"DAYNIGHT_GRANT_DIAGNOSTICS_PROCESS_HELPER": mode})
			process.command.Stdout, process.command.Stderr = &process.logs, &process.logs
			if process.command.Start() != nil {
				t.Fatal("cannot start owned diagnostic control")
			}
			go func() { process.err = process.command.Wait(); close(process.done) }()
			t.Cleanup(func() {
				if reaped, err := grantStopProcess(process.command.Process, process.done, time.Second, time.Second); !reaped || err != nil {
					t.Error("owned diagnostic control cleanup failed")
				}
			})
			select {
			case <-process.done:
			case <-time.After(5 * time.Second):
				t.Fatal("owned diagnostic control did not exit")
			}
			value := process.exitEvidence(true)
			if value.Wait != "exit" || mode == "exit" && (value.ExitCode == nil || *value.ExitCode != 23 || value.Signal != nil) || mode == "signal" && (value.Signal == nil || *value.Signal != int(syscall.SIGKILL) || value.ExitCode != nil) {
				t.Fatalf("lost process exit facts: %+v", value)
			}
			if mode == "exit" {
				logs := process.logs.diagnostics()
				if len(logs.Failures) != 1 || logs.Failures[0].Detail != "database_connect" || !logs.Ignored || grantReadiness(t.Context(), process.done, func() bool { t.Fatal("polled after exit"); return false }) != "exited" {
					t.Fatal("early exit lost safe startup classification")
				}
			}
		})
	}
}
