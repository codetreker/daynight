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
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestRouteBackendRejectsInvalidScopes(t *testing.T) {
	const failureCase = "DAYNIGHT_ROUTE_SCOPE_FAILURE"
	if scenario := os.Getenv(failureCase); scenario != "" {
		backend := newRouteBackend(t)
		backend.DAO.LockCredentialFn = func(context.Context, model.Principal, time.Time) error { return nil }
		backend.DAO.SaveSessionFn = func(context.Context, store.SessionRecord) error { return nil }
		input := func() any { return "supplied" }
		backend.Declare("credential", map[string]int{"LockCredential": 1}, input, false)
		names := []string{"credential"}
		if scenario == "escaped" {
			backend.Declare("longer", map[string]int{"LockCredential": 1, "SaveSession": 1}, input, false)
			names = append(names, "longer")
		}
		if scenario == "unconfigured" {
			backend.DAO.LockCredentialFn = nil
		}
		if scenario == "extra-use" {
			backend.ExpectUses("credential", 1)
		}
		ctx := backend.Plan(t.Context(), names...)
		var escaped store.SessionDAO
		work := func(scope store.SessionScope) error {
			escaped = scope.SessionDAO()
			if scenario == "bot" {
				_, err := scope.BotDAO().Bot(ctx, "bot")
				return err
			}
			if scenario == "missing" {
				return nil
			}
			if err := escaped.LockCredential(ctx, model.Principal{}, time.Time{}); err != nil {
				return err
			}
			if scenario == "extra" {
				return escaped.LockCredential(ctx, model.Principal{}, time.Time{})
			}
			return nil
		}
		_, _ = backend.WriteSession(ctx, work)
		switch scenario {
		case "escaped":
			_ = escaped.SaveSession(ctx, store.SessionRecord{})
		case "extra-use":
			_, _ = backend.WriteSession(ctx, work)
		}
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct{ name, message string }{
		{"unconfigured", "unconfigured route DAO call LockCredential"},
		{"bot", "unconfigured route DAO call Bot"},
		{"extra", "unexpected route DAO call LockCredential"},
		{"missing", "route transaction matches 0 complete contracts"},
		{"escaped", "route DAO scope already closed: SaveSession"},
		{"extra-use", "route transaction has no enabled contract"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, executable, "-test.run=^TestRouteBackendRejectsInvalidScopes$")
			command.Env = append(os.Environ(), failureCase+"="+scenario.name)
			output, err := command.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatal("scope failure witness timed out", ctx.Err())
			}
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() == 0 || !strings.Contains(string(output), scenario.message) {
				t.Fatalf("scope witness %v\n%s", err, output)
			}
		})
	}
}

func TestRouteBackendScopesKeepIndependentOutcomesAndInputs(t *testing.T) {
	backend := newRouteBackend(t)
	var deferredInputCalls int
	backend.Declare("credential", map[string]int{"LockCredential": 1}, func() any { return "credential-input" }, false)
	backend.Declare("task", map[string]int{"LockTask": 1}, func() any { deferredInputCalls++; return "task-input" }, false)
	cause := errors.New("foreground completion uncertain")
	backend.Outcome("credential", func(context.Context, error) (store.Completion, error) {
		return store.Completion{Outcome: store.TransactionUnknown}, cause
	})
	backend.DAO.LockCredentialFn = func(ctx context.Context, _ model.Principal, _ time.Time) error {
		if routeInputFor[string](ctx) != "credential-input" {
			t.Fatal("credential scope received another input")
		}
		return nil
	}
	backend.DAO.LockTaskFn = func(ctx context.Context, _, _ string) (store.SessionTask, error) {
		if routeInputFor[string](ctx) != "task-input" {
			t.Fatal("task scope received another input")
		}
		return store.SessionTask{}, nil
	}
	ctx := backend.Plan(t.Context(), "credential", "task")
	completion, err := backend.WriteSession(ctx, func(scope store.SessionScope) error {
		return scope.SessionDAO().LockCredential(ctx, model.Principal{}, time.Time{})
	})
	if completion.Outcome != store.TransactionUnknown || !errors.Is(err, cause) || deferredInputCalls != 0 {
		t.Fatal("foreground outcome or lazy input changed", completion, err, deferredInputCalls)
	}
	completion, err = backend.WriteSession(ctx, func(scope store.SessionScope) error {
		_, err := scope.SessionDAO().LockTask(ctx, "project", "task")
		return err
	})
	if completion.Outcome != store.TransactionCommitted || err != nil || deferredInputCalls != 1 {
		t.Fatal("foreground failure poisoned an independent scope", completion, err, deferredInputCalls)
	}
	backend.Finish(ctx)
}

type routeActivationInput struct{ queued bool }

func routeActivationBackend(t *testing.T) (*routeBackend, *routeActivationInput) {
	t.Helper()
	backend := newRouteBackend(t)
	input := &routeActivationInput{}
	snapshot := func() any { return *input }
	backend.Declare("idle", map[string]int{"LockTask": 1, "QueuedTerminalOperation": 1}, snapshot, true)
	backend.Declare("dispatch", map[string]int{"LockTask": 1, "QueuedTerminalOperation": 1, "TerminalOperation": 1}, snapshot, true)
	backend.ExpectUses("dispatch", 0)
	backend.DAO.LockTaskFn = func(context.Context, string, string) (store.SessionTask, error) { return store.SessionTask{}, nil }
	backend.DAO.QueuedTerminalOperationFn = func(ctx context.Context, _ string) ([]string, error) {
		if routeInputFor[routeActivationInput](ctx).queued {
			return []string{"operation"}, nil
		}
		return nil, nil
	}
	backend.DAO.TerminalOperationFn = func(_ context.Context, _, operation string) (store.TerminalOperation, error) {
		if operation != "operation" {
			t.Fatal("dispatch changed the supplied operation ID")
		}
		return store.TerminalOperation{OperationID: operation}, nil
	}
	return backend, input
}

func activateRouteDispatch(backend *routeBackend, input *routeActivationInput) {
	backend.mu.Lock()
	defer backend.mu.Unlock()
	backend.contracts["dispatch"].minimum = 1
	backend.contracts["dispatch"].maximum = 1
	input.queued = true
}

func routeActivationTick(ctx context.Context, scope store.SessionScope) (bool, error) {
	dao := scope.SessionDAO()
	if _, err := dao.LockTask(ctx, "project", "task"); err != nil {
		return false, err
	}
	ids, err := dao.QueuedTerminalOperation(ctx, "session")
	if err != nil {
		return false, err
	}
	for _, id := range ids {
		if _, err := dao.TerminalOperation(ctx, "session", id); err != nil {
			return false, err
		}
	}
	return len(ids) != 0, nil
}

func TestRouteBackendActivationBeforeFirstDAOUsesMatchingFacts(t *testing.T) {
	backend, input := routeActivationBackend(t)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	ctx = backend.Plan(ctx, "idle", "dispatch")
	entered, release := make(chan struct{}), make(chan struct{})
	type result struct {
		completion store.Completion
		err        error
		dispatched bool
	}
	done := make(chan result, 1)
	go func() {
		var dispatched bool
		completion, err := backend.WriteSession(ctx, func(scope store.SessionScope) error {
			close(entered)
			select {
			case <-release:
			case <-ctx.Done():
				return ctx.Err()
			}
			var err error
			dispatched, err = routeActivationTick(ctx, scope)
			return err
		})
		done <- result{completion: completion, err: err, dispatched: dispatched}
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("timer scope did not enter its callback", ctx.Err())
	}
	activateRouteDispatch(backend, input)
	close(release)
	select {
	case got := <-done:
		if got.err != nil || got.completion.Outcome != store.TransactionCommitted || !got.dispatched {
			t.Fatal("valid activated tick was rejected", got)
		}
	case <-ctx.Done():
		t.Fatal("activated timer scope did not finish", ctx.Err())
	}
	backend.Finish(ctx)
}

func TestRouteBackendActivationAfterFirstDAOKeepsScopeSnapshot(t *testing.T) {
	backend, input := routeActivationBackend(t)
	ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
	defer cancel()
	ctx = backend.Plan(ctx, "idle", "dispatch")
	firstRead, release := make(chan struct{}), make(chan struct{})
	first := true
	backend.DAO.LockTaskFn = func(ctx context.Context, _, _ string) (store.SessionTask, error) {
		if first {
			first = false
			if routeInputFor[routeActivationInput](ctx).queued {
				t.Error("first tick started from future facts")
			}
			close(firstRead)
			select {
			case <-release:
			case <-ctx.Done():
				return store.SessionTask{}, ctx.Err()
			}
		}
		return store.SessionTask{}, nil
	}
	type result struct {
		completion store.Completion
		err        error
		dispatched bool
	}
	done := make(chan result, 1)
	go func() {
		var dispatched bool
		completion, err := backend.WriteSession(ctx, func(scope store.SessionScope) error {
			var err error
			dispatched, err = routeActivationTick(ctx, scope)
			return err
		})
		done <- result{completion: completion, err: err, dispatched: dispatched}
	}()
	select {
	case <-firstRead:
	case <-ctx.Done():
		t.Fatal("timer scope did not read its starting facts", ctx.Err())
	}
	activateRouteDispatch(backend, input)
	close(release)
	select {
	case got := <-done:
		if got.err != nil || got.completion.Outcome != store.TransactionCommitted || got.dispatched {
			t.Fatal("current tick mixed later facts into its snapshot", got)
		}
	case <-ctx.Done():
		t.Fatal("original timer scope did not finish", ctx.Err())
	}
	var dispatched bool
	completion, err := backend.WriteSession(ctx, func(scope store.SessionScope) error {
		var err error
		dispatched, err = routeActivationTick(ctx, scope)
		return err
	})
	if err != nil || completion.Outcome != store.TransactionCommitted || !dispatched {
		t.Fatal("next tick missed the activated intent", completion, err, dispatched)
	}
	backend.Finish(ctx)
}
