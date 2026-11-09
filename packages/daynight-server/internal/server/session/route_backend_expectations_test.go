package session_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
)

func TestRouteUsecasesRejectMissingOrUnexpectedCalls(t *testing.T) {
	const failureCase = "DAYNIGHT_ROUTE_USECASE_FAILURE"
	if scenario := os.Getenv(failureCase); scenario != "" {
		backend := newRouteBackend(t)
		if scenario != "unconfigured" && scenario != "background" {
			backend.Funcs.Current = func(context.Context, model.Principal, string, string) (map[string]any, error) {
				return map[string]any{"status": "supplied"}, nil
			}
		}
		switch scenario {
		case "missing":
			return
		case "zero":
			backend.ExpectCalls("Current", 0)
		case "background":
			failed := make(chan struct{})
			backend.OnFailure = func(error) { close(failed) }
			done := make(chan struct{})
			go func() {
				defer close(done)
				_, _ = backend.Calls.Current(t.Context(), model.Principal{}, "project", "task")
			}()
			select {
			case <-failed:
			case <-time.After(time.Second):
				t.Fatal("background failure was not independently reported")
			}
			<-done
			return
		}
		_, _ = backend.Calls.Current(t.Context(), model.Principal{}, "project", "task")
		if scenario == "extra" {
			_, _ = backend.Calls.Current(t.Context(), model.Principal{}, "project", "task")
		}
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct{ name, message string }{
		{"unconfigured", "unexpected usecase Current call"},
		{"extra", "unexpected usecase Current call"},
		{"zero", "unexpected usecase Current call"},
		{"missing", "Current calls = 0, want 1"},
		{"background", "unexpected usecase Current call"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, executable, "-test.run=^TestRouteUsecasesRejectMissingOrUnexpectedCalls$")
			command.Env = append(os.Environ(), failureCase+"="+scenario.name)
			output, err := command.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatal("usecase failure witness timed out", ctx.Err())
			}
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() == 0 || !strings.Contains(string(output), scenario.message) {
				t.Fatalf("usecase witness %v\n%s", err, output)
			}
		})
	}
}

func TestRouteUsecasesPassOriginalContextAndIndependentResults(t *testing.T) {
	backend := newRouteBackend(t)
	principal := model.Principal{Kind: model.PATCredential, UserID: "owner", CredentialID: "credential"}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	backend.Funcs.Current = func(actual context.Context, p model.Principal, project, task string) (map[string]any, error) {
		if actual != ctx || p != principal || project != "project" || task != "task" {
			t.Fatal("usecase arguments changed")
		}
		return map[string]any{"status": "registered"}, nil
	}
	cause := errors.New("startup unavailable")
	backend.Funcs.CurrentWithStartup = func(actual context.Context, p model.Principal, project, task string) (map[string]any, error) {
		return nil, cause
	}
	current, err := backend.Calls.Current(ctx, principal, "project", "task")
	if err != nil || current["status"] != "registered" {
		t.Fatal("supplied current result changed", current, err)
	}
	_, err = backend.Calls.CurrentWithStartup(ctx, principal, "project", "task")
	if err != cause {
		t.Fatal("supplied failure lost its identity", err)
	}
}

func TestRouteUsecaseCancellationExitsAfterObservedEntry(t *testing.T) {
	backend := newRouteBackend(t)
	entered := make(chan struct{})
	backend.Funcs.Timeline = func(ctx context.Context, _ model.Principal, _, _, _, _, _ string, _ int) (map[string]any, error) {
		close(entered)
		<-ctx.Done()
		return nil, ctx.Err()
	}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := backend.Calls.Timeline(ctx, model.Principal{}, "project", "task", "session", "tail", "", 10)
		done <- err
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("usecase did not start")
	}
	cancel()
	select {
	case err := <-done:
		if err != context.Canceled {
			t.Fatal("cancellation was not preserved", err)
		}
	case <-time.After(time.Second):
		t.Fatal("canceled usecase did not exit")
	}
}

func TestRouteUsecasesRepeatOnlyExplicitPolls(t *testing.T) {
	backend := newRouteBackend(t)
	backend.Funcs.Poll = func(context.Context, sp.ControllerFence) ([]map[string]any, error) { return []map[string]any{}, nil }
	backend.RequireCalls("Poll", 2)
	for range 2 {
		if _, err := backend.Calls.Poll(t.Context(), sp.ControllerFence{}); err != nil {
			t.Fatal(err)
		}
	}
	if backend.Called("Poll") != 2 || backend.TotalCalls() != 2 {
		t.Fatal("poll call accounting changed")
	}
}
