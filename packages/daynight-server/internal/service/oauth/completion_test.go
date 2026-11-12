package oauth

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func TestAuthorizationUnknownPreservesCompletionCause(t *testing.T) {
	cause := &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CommitAttempted: true, CleanupFailed: true, Cause: errors.Join(context.DeadlineExceeded, core.ErrInvalidGrant)}
	err := completionError(store.Completion{Outcome: store.TransactionUnknown}, cause)
	var transaction *store.TransactionError
	if !errors.Is(err, core.ErrAuthorizationUnknown) || !errors.Is(err, cause) || !errors.Is(err, context.DeadlineExceeded) || !errors.As(err, &transaction) || transaction != cause || !transaction.CleanupFailed {
		t.Fatalf("unknown completion lost its cause: %v", err)
	}
}

func TestCodeRefusalDoesNotHideJoinedStorageFailure(t *testing.T) {
	database := &store.Error{Phase: "query", DatabaseFailure: true, SQLState: "08006", Cause: errors.New("connection failed")}
	joined := errors.Join(core.ErrInvalidGrant, database)
	if got := grantRefusal(joined); got != joined {
		t.Fatalf("mixed refusal was normalized: %v", got)
	}
	err := grantRefusal(core.ErrInvalidGrant)
	var fault *model.Fault
	if !errors.Is(err, core.ErrInvalidGrant) || !errors.As(err, &fault) || fault.Code != "invalid_grant" {
		t.Fatalf("plain rule refusal lost its identity: %v", err)
	}
}
