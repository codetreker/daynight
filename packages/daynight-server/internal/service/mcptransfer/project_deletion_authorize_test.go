package mcptransfer

import (
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/operation"
)

func TestDeletedProjectAuthorizationCompletionPrecedence(t *testing.T) {
	for _, test := range []struct {
		name, phase    string
		outcome        store.TransactionOutcome
		cleanup, known bool
	}{
		{"confirmed rollback", "operation", store.TransactionNotCommitted, false, true},
		{"unknown commit", "commit", store.TransactionUnknown, false, false},
		{"cleanup failure", "cleanup", store.TransactionUnknown, true, false},
		{"cleanup failure with rollback fact", "cleanup", store.TransactionNotCommitted, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newFixture(t)
			record := f.record()
			failure := &store.TransactionError{Phase: test.phase, Outcome: test.outcome, CleanupFailed: test.cleanup, Cause: model.ErrNotFound}
			f.db.expect(store.Completion{Outcome: test.outcome}, failure, auth(f.actor, record, model.ErrNotFound))
			err := f.lifecycle.Authorize(t.Context(), f.actor, record.ProjectID, record.TaskID)
			if !errors.Is(err, model.ErrNotFound) || !errors.Is(err, failure) {
				t.Fatalf("missing original error chain: %v", err)
			}
			fault, known := operation.KnownFault(err)
			if known != test.known || known && fault.Code != "not_found" {
				t.Fatalf("classification: %#v %t %v", fault, known, err)
			}
		})
	}
}
