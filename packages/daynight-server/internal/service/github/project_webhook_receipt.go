package github

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/google/uuid"
)

// ProjectWebhookReceiver persists an already authenticated project delivery.
type ProjectWebhookReceiver struct {
	db     store.ProjectWriter
	logger *slog.Logger
}

func NewProjectWebhookReceiver(db store.ProjectWriter, logger *slog.Logger) (*ProjectWebhookReceiver, error) {
	if db == nil {
		return nil, errors.New("project webhook receiver requires store")
	}
	if logger == nil {
		logger = slog.Default()
	}
	return &ProjectWebhookReceiver{db: db, logger: logger}, nil
}

// Receive reports a receipt only after the transaction confirms its commit.
// The caller owns signature verification and the request deadline.
func (r *ProjectWebhookReceiver) Receive(ctx context.Context, projectID string, identity core.ProjectWebhookIdentity, event core.WebhookEvent) (core.ProjectWebhookReceiptResult, error) {
	id, err := uuid.Parse(projectID)
	if err != nil || id == uuid.Nil || id.String() != projectID || identity.ProjectID != projectID {
		return "", errors.New("invalid project webhook project ID")
	}
	requestID := uuid.NewString()
	var result core.ProjectWebhookReceiptResult
	completion, err := r.db.WriteProject(ctx, projectID, func(scope store.ProjectWriteScope) error {
		receipt, ok := scope.(store.GitHubProjectWebhookReceiptScope)
		if !ok {
			return errors.New("project webhook receipt scope unavailable")
		}
		var operationErr error
		result, operationErr = core.RecordProjectWebhook(ctx, receipt.GitHubProjectWebhookReceiptDAO(), identity, event, requestID)
		return operationErr
	})
	err = committed(completion, err)
	attrs := []any{"component", "github_webhook", "phase", "receive", "request_id", requestid.From(ctx), "queue_request_id", requestID, "project_id", projectID, "configuration_version", identity.Version, "event", event.Kind, "delivery_id", event.DeliveryID, "write_outcome", string(completion.Outcome)}
	if event.Kind == "pull_request" {
		attrs = append(attrs, "pr_number", event.Number)
	}
	if err != nil {
		r.logger.WarnContext(ctx, "project github webhook receipt failed", attrs...)
		return "", fmt.Errorf("project webhook receipt: %w", err)
	}
	r.logger.InfoContext(ctx, "project github webhook receipt recorded", append(attrs, "result", string(result))...)
	return result, nil
}
