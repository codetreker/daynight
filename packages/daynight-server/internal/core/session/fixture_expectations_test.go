package session

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestFixtureDAORejectsUnexpectedAndMissingCalls(t *testing.T) {
	const failureCase = "DAYNIGHT_FIXTURE_FAILURE_CASE"
	if scenario := os.Getenv(failureCase); scenario != "" {
		dao := newFixtureDAO(t)
		ctx := dao.ContextPhase(t.Context(), map[string]int{"LockCredential": 1})
		if scenario != "unconfigured" {
			dao.LockCredentialFn = func(context.Context, model.Principal, time.Time) error { return nil }
		}
		switch scenario {
		case "unconfigured":
			_ = dao.LockCredential(ctx, model.Principal{}, time.Time{})
		case "extra":
			_ = dao.LockCredential(ctx, model.Principal{}, time.Time{})
			_ = dao.LockCredential(ctx, model.Principal{}, time.Time{})
		case "missing":
			dao.FinishContext(ctx)
		default:
			t.Fatalf("unknown fixture failure scenario %q", scenario)
		}
		return
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []struct{ name, message string }{{"unconfigured", "unconfigured DAO call LockCredential"}, {"extra", "unexpected DAO call LockCredential"}, {"missing", "DAO phase missing 1 LockCredential calls"}} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, executable, "-test.run=^TestFixtureDAORejectsUnexpectedAndMissingCalls$")
			command.Env = append(os.Environ(), failureCase+"="+scenario.name)
			output, err := command.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatal("fixture failure witness timed out", ctx.Err())
			}
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() == 0 || !strings.Contains(string(output), scenario.message) {
				t.Fatalf("fixture failure witness: %v\n%s", err, output)
			}
		})
	}
}

func TestFixtureDAOPlansBelongToIndependentContexts(t *testing.T) {
	dao := newFixtureDAO(t)
	dao.LockCredentialFn = func(context.Context, model.Principal, time.Time) error { return nil }
	first := dao.ContextPhase(t.Context(), map[string]int{"LockCredential": 1})
	second := dao.ContextPhase(t.Context(), map[string]int{"LockCredential": 1})
	done := make(chan error, 1)
	go func() { done <- dao.LockCredential(second, model.Principal{}, time.Time{}) }()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	dao.FinishContext(second)
	if err := dao.LockCredential(first, model.Principal{}, time.Time{}); err != nil {
		t.Fatal(err)
	}
	dao.FinishContext(first)
	if dao.Called("LockCredential") != 2 {
		t.Fatal("independent context calls were lost")
	}
}
