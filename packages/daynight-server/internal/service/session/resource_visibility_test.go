package session

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestPrivateResourceRefusalPreservesCoreCauseAndIndependentCompletion(t *testing.T) {
	for _, point := range []string{"not committed", "unknown", "cleanup failed", "independent cause"} {
		t.Run(point, func(t *testing.T) {
			ctx := t.Context()
			scope := &archiveCompletionOrderScope{}
			completion := store.Completion{Outcome: store.TransactionNotCommitted}
			failure := &store.TransactionError{Phase: "operation", Outcome: completion.Outcome, Cause: model.ErrNotFound}
			independent := errors.New("independent transaction failure")
			switch point {
			case "unknown":
				completion.Outcome = store.TransactionUnknown
				failure.Outcome, failure.CommitAttempted = completion.Outcome, true
				failure.Cause = errors.Join(model.ErrNotFound, independent)
			case "cleanup failed":
				failure.CleanupFailed = true
				failure.Cause = errors.Join(model.ErrNotFound, independent)
			case "independent cause":
				failure.Cause = errors.Join(model.ErrNotFound, independent)
			}
			var calls []string
			coreOperation := func(actual context.Context, bound store.SessionScope) error {
				calls = append(calls, "core refusal")
				if actual != ctx || bound != scope {
					t.Fatal("core operation lost the service transaction binding")
				}
				return model.ErrNotFound
			}
			service := &Service{writer: archiveCompletionOrderWriter(func(actual context.Context, run func(store.SessionScope) error) (store.Completion, error) {
				calls = append(calls, "transaction")
				if actual != ctx || run(scope) != model.ErrNotFound {
					t.Fatal("service changed the supplied core refusal")
				}
				calls = append(calls, "completion")
				return completion, failure
			})}
			err := service.write(ctx, func(outcome store.TransactionOutcome) {
				calls = append(calls, "finish")
				if outcome != completion.Outcome {
					t.Fatal("service inferred completion from the core refusal", outcome)
				}
			}, func(bound store.SessionScope) error { return coreOperation(ctx, bound) })
			if !errors.Is(err, model.ErrNotFound) {
				t.Fatal("private resource refusal lost its core cause", err)
			}
			var fault *model.Fault
			if point == "not committed" {
				if !errors.As(err, &fault) || fault.Code != "not_found" {
					t.Fatal("confirmed noncommit lost the ordinary domain refusal", err)
				}
			} else if err != failure || errors.As(err, &fault) || !errors.Is(err, independent) {
				t.Fatal("ordinary not-found suppressed completion or independent failure facts", err)
			}
			if !reflect.DeepEqual(calls, []string{"transaction", "core refusal", "completion", "finish"}) {
				t.Fatal("service repeated or reordered the core operation", calls)
			}
		})
	}
}
