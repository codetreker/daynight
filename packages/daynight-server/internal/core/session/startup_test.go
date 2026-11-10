package session

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestStartupTaskReadPropagatesCancellation(t *testing.T) {
	f := setup(t)
	ctx := f.dao.ContextPhase(context.Background(), map[string]int{"LockTask": 1})
	defer func() { f.dao.FinishContext(ctx) }()
	f.dao.LockTaskFn = func(ctx context.Context, project, id string) (store.SessionTask, error) {
		if project != f.project || id != f.task {
			t.Fatal("unexpected Task identity")
		}
		return store.SessionTask{}, ctx.Err()
	}
	err := testTransact(f.s, f.writer, ctx, func(tx *operationTx) error {
		ctx, cancel := context.WithCancel(ctx)
		cancel()
		_, err := tx.dao.LockTask(ctx, f.project, f.task)
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Task evidence read: %v", err)
	}
}
func TestCurrentStartupNegotiationFiltersStaleReports(t *testing.T) {
	f := setup(t)
	ctx := t.Context()
	defer func() { f.dao.FinishContext(ctx) }()
	ctx = f.dao.ContextPhase(ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "CurrentTaskSession": 1})
	before, err := f.s.CurrentWithStartup(ctx, f.p, f.project, f.task)
	f.dao.FinishContext(ctx)
	if err != nil || before["status"] != "not_registered" {
		t.Fatalf("unregistered current: %#v %v", before, err)
	}
	if _, exists := before["startupReport"]; exists {
		t.Fatal("unregistered response changed shape")
	}
	ctx = f.dao.ContextPhase(ctx, map[string]int{"LockTaskRegistration": 1, "LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "FindTaskRegistration": 1, "InsertTaskSession": 1})
	v, err := f.s.Register(ctx, f.p, f.project, f.task, f.r)
	f.dao.FinishContext(ctx)
	if err != nil {
		t.Fatal(err)
	}
	f.SelectRegistrationWrite(t)
	read := func(want *sp.StartupReport) {
		t.Helper()
		ctx = f.dao.ContextPhase(ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "CurrentTaskSession": 1, "SessionBotID": 1, "LockSession": 1})
		old, err := f.s.Current(ctx, f.p, f.project, f.task)
		f.dao.FinishContext(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if _, exists := old["startupReport"]; exists {
			t.Fatal("legacy response changed shape")
		}
		ctx = f.dao.ContextPhase(ctx, map[string]int{"LockTask": 1, "LockCredential": 1, "ProjectAccess": 1, "CurrentTaskSession": 1, "SessionBotID": 1, "LockSession": 1})
		current, err := f.s.CurrentWithStartup(ctx, f.p, f.project, f.task)
		f.dao.FinishContext(ctx)
		if err != nil {
			t.Fatal(err)
		}
		actual, exists := current["startupReport"]
		if !exists || want == nil && actual != nil || want != nil && !reflect.DeepEqual(actual, want) {
			t.Fatalf("startup report: %#v want %#v", actual, want)
		}
		delete(current, "startupReport")
		if !reflect.DeepEqual(current, old) {
			t.Fatal("negotiation changed existing Session fields")
		}
	}
	read(nil)
	report := sp.StartupReport{SchemaVersion: 1, Source: "worker", SessionID: v.SessionID, ClaimID: v.ClaimID, ExecutionGeneration: v.ExecutionGeneration, ControllerInstanceID: v.Identity.ControllerInstanceID, Revision: "1", ObservedAt: "2026-11-05T00:00:00Z"}
	report.Startup.State, report.Startup.ReasonCode, report.Recovery.State = "unknown", "native_timeout", "none"
	f.data.Task.StartupReport = &report
	read(&report)
	for name, mutate := range map[string]func(*sp.StartupReport){
		"session":    func(r *sp.StartupReport) { r.SessionID = uuid.NewString() },
		"claim":      func(r *sp.StartupReport) { r.ClaimID = uuid.NewString() },
		"generation": func(r *sp.StartupReport) { r.ExecutionGeneration = "2" },
		"instance":   func(r *sp.StartupReport) { r.ControllerInstanceID = uuid.NewString() },
	} {
		t.Run(name, func(t *testing.T) { stale := report; mutate(&stale); f.data.Task.StartupReport = &stale; read(nil) })
	}
	priorTask := f.dao.LockTaskFn
	cause := errors.New("invalid stored startup report")
	decodeError := fmt.Errorf("read Task startup report: %w", cause)
	f.dao.LockTaskFn = func(context.Context, string, string) (store.SessionTask, error) {
		return store.SessionTask{}, decodeError
	}
	ctx = f.dao.ContextPhase(ctx, map[string]int{"LockTask": 1})
	if _, err := f.s.CurrentWithStartup(ctx, f.p, f.project, f.task); err != decodeError || !errors.Is(err, cause) {
		t.Fatal("stored startup evidence error lost", err)
	}
	f.dao.FinishContext(ctx)
	f.dao.LockTaskFn = priorTask
	f.data.Task.StartupReport = &report
	refusal := &model.Fault{Code: "unauthenticated", Message: "Credential is revoked."}
	f.dao.LockCredentialFn = func(_ context.Context, p model.Principal, _ time.Time) error {
		if p != f.p {
			t.Fatal("unexpected principal")
		}
		return refusal
	}
	ctx = f.dao.ContextPhase(ctx, map[string]int{"LockTask": 1, "LockCredential": 1})
	if _, err := f.s.CurrentWithStartup(ctx, f.p, f.project, f.task); err != refusal {
		t.Fatal("revoked credential read startup evidence", err)
	}
	f.dao.FinishContext(ctx)
}
