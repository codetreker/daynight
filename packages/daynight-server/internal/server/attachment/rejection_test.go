package attachment

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	attachmentservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
)

func TestDefiniteAttachmentRejectionPreservesUncertainEffects(t *testing.T) {
	fault := &model.Fault{Code: "path_conflict", Message: "conflict"}
	rollback := func(err error) error {
		return &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
	}
	for _, tc := range []struct {
		name     string
		err      error
		definite bool
	}{
		{"direct refusal", fault, true},
		{"rolled back before publication", &filestorage.PublicationError{Outcome: filestorage.NotPublished, Cause: rollback(fault)}, true},
		{"publication unknown", &filestorage.PublicationError{Outcome: filestorage.PublicationUnknown, Cause: rollback(fault)}, false},
		{"published", &filestorage.PublicationError{Outcome: filestorage.Published, Cause: rollback(fault)}, false},
		{"file effect", &attachmentservice.FileEffectError{Cause: rollback(fault)}, false},
		{"commit attempted", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CommitAttempted: true, Cause: fault}, false},
		{"cleanup failed", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, CleanupFailed: true, Cause: fault}, false},
		{"independent cleanup error", errors.Join(fault, errors.New("cleanup")), false},
		{"cancellation", errors.Join(fault, context.Canceled), false},
		{"unknown failure", errors.New("unknown"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := definiteAttachmentRejection(tc.err); got != tc.definite {
				t.Fatalf("definite=%v want %v", got, tc.definite)
			}
		})
	}
}
