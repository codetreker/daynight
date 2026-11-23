package project

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/project"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type appProjectAuthorityChangeStore struct{ appLifecycleTestStore }

func (s appProjectAuthorityChangeStore) WriteGitHubProjectDeletion(ctx context.Context, id string, operation func(store.GitHubProjectDeletionScope) error) (store.Completion, error) {
	s.f.access.TeamRole = nil
	return s.appLifecycleTestStore.WriteGitHubProjectDeletion(ctx, id, operation)
}

func TestAppProjectDeletionRechecksAuthorityInsideTransaction(t *testing.T) {
	_, f := newAppLifecycleTest(t, "")
	s := NewAppProjects(appProjectAuthorityChangeStore{appLifecycleTestStore{f: f}})
	r, err := s.Delete(t.Context(), f.principal, f.project.ID)
	var fault *model.Fault
	if r.Deleted || !errors.As(err, &fault) || fault.Code != "forbidden" || len(f.retirementCalls) != 0 || f.writeCalls != 1 {
		t.Fatalf("changed authority continued retirement: receipt=%+v error=%v writes=%d calls=%v", r, err, f.writeCalls, f.retirementCalls)
	}
}

func TestAppProjectDeletionPreservesPreflightRefusal(t *testing.T) {
	s, f := newAppLifecycleTest(t, "preflight")
	refusal := &model.Fault{Code: "not_found", Message: "Project is unavailable."}
	f.cause = refusal
	r, err := s.Delete(t.Context(), f.principal, f.project.ID)
	if r.Deleted || err != refusal || f.writeCalls != 0 {
		t.Fatalf("preflight refusal changed: receipt=%+v error=%v writes=%d", r, err, f.writeCalls)
	}
}

func TestAppProjectDeletionCleanupFailureRetainsUnknownOutcome(t *testing.T) {
	s, f := newAppLifecycleTest(t, "no callback")
	cause := errors.New("rollback confirmation lost")
	f.completion.Outcome = store.TransactionNotCommitted
	f.cause = &store.TransactionError{Phase: "operation", Cause: cause, Outcome: store.TransactionNotCommitted, CleanupFailed: true}
	r, err := s.Delete(t.Context(), f.principal, f.project.ID)
	var failure *DeletionFailure
	if r.Deleted || !errors.As(err, &failure) || failure.Outcome != store.TransactionUnknown || !errors.Is(err, cause) || f.writeCalls != 1 {
		t.Fatalf("cleanup uncertainty lost or replayed: receipt=%+v error=%v writes=%d", r, err, f.writeCalls)
	}
}

func TestAppProjectTransferValidationAndUnconfirmedCompletion(t *testing.T) {
	t.Run("invalid input", func(t *testing.T) {
		s, f := newAppLifecycleTest(t, "")
		r, err := s.Transfer(t.Context(), f.principal, "invalid", core.TransferInput{Ownership: f.project.Ownership, TargetTeam: core.TeamVersion{ID: "ef000000-0000-4000-8000-000000000002", Version: 1}, ExpectedUserID: f.principal.UserID})
		if err == nil || r.Changed || f.writeCalls != 0 {
			t.Fatalf("invalid transfer: %+v %v writes=%d", r, err, f.writeCalls)
		}
	})
	t.Run("unknown after callback", func(t *testing.T) {
		s, f := newAppLifecycleTest(t, "")
		f.completion.Outcome = store.TransactionUnknown
		r, err := s.Transfer(t.Context(), f.principal, f.project.ID, core.TransferInput{Ownership: f.project.Ownership, TargetTeam: core.TeamVersion{ID: "ef000000-0000-4000-8000-000000000002", Version: 1}, ExpectedUserID: f.principal.UserID})
		if err == nil || r.Changed || f.writeCalls != 1 || len(f.retirementCalls) != 3 {
			t.Fatalf("unknown transfer reported a receipt or replayed: %+v %v writes=%d calls=%v", r, err, f.writeCalls, f.retirementCalls)
		}
	})
}
