package bot

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type attentionProjectionKey struct{}

// WithAttentionProjection marks an explicit request for the attention count.
func WithAttentionProjection(ctx context.Context) context.Context {
	return context.WithValue(ctx, attentionProjectionKey{}, true)
}

// AttentionProjectionRequested reports whether the caller requested attention.
func AttentionProjectionRequested(ctx context.Context) bool {
	requested, _ := ctx.Value(attentionProjectionKey{}).(bool)
	return requested
}

// RequireWorker retains the existing Worker ownership check for Bot operations.
func RequireWorker(ctx context.Context, reader store.BotReader, principal model.Principal, workerID string) error {
	return botWorkerError(reader.BotWorker(ctx, principal.UserID, workerID))
}

// RequireDefinition checks only Bot definition operations. Session and runtime
// operations require their own admission and cannot be inferred from Bot scopes.
// The caller retains existing ownership and credential checks and supplies the
// authorization snapshot appropriate to the operation's admission boundary.
func RequireDefinition(auth model.CredentialAuthorization, operations ...scopepolicy.Operation) error {
	if err := auth.Validate(); err != nil {
		return err
	}
	if len(operations) == 0 {
		return fmt.Errorf("Bot definition operation is required")
	}
	for _, operation := range operations {
		switch operation {
		case scopepolicy.BotRead, scopepolicy.BotWrite, scopepolicy.BotDelete:
		default:
			return fmt.Errorf("not a Bot definition operation: %q", operation)
		}
	}
	required, err := scopepolicy.Requirements(operations...)
	if err != nil {
		return err
	}
	if auth.Policy == nil {
		return nil
	}
	if err := auth.Policy.Require(required...); err != nil {
		if errors.Is(err, scopepolicy.ErrInsufficientScope) {
			return &model.Fault{Code: "insufficient_scope", Message: "Credential scope does not permit this Bot operation.", Cause: err}
		}
		return err
	}
	return nil
}
