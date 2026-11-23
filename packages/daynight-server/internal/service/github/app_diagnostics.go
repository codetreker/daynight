package github

import (
	"context"
	"errors"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

// Causes remain available to callers. Logs select typed metadata because driver
// and transport causes may contain SQL parameters or private response content.
func appErrorAttributes(err error) []any {
	code := fail(err).Code
	switch {
	case errors.Is(err, store.ErrGitHubAppWorkUnavailable), errors.Is(err, errLease):
		code = "github_authorization_changed"
	case errors.Is(err, context.Canceled):
		code = "cancelled"
	case errors.Is(err, context.DeadlineExceeded):
		code = "deadline_exceeded"
	}
	attrs := []any{"result_code", code}
	if failed, state := store.DatabaseErrorFacts(err); failed {
		attrs = append(attrs, "database_failure", true, "sql_state", state)
	}
	var database *store.Error
	if errors.As(err, &database) {
		attrs = append(attrs, "database_phase", database.Phase)
	}
	var tx *store.TransactionError
	if errors.As(err, &tx) {
		attrs = append(attrs, "transaction_phase", tx.Phase, "write_outcome", string(tx.Outcome), "cleanup_failed", tx.CleanupFailed)
	}
	var upstream *remote.Error
	if errors.As(err, &upstream) {
		attrs = append(attrs, "remote_code", upstream.Code, "remote_status", upstream.Status, "github_request_id", upstream.RequestID)
	}
	return attrs
}
