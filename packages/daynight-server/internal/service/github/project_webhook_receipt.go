package github

import (
	"context"
	"errors"
	"fmt"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

// ProjectWebhookReceiver persists an already authenticated project delivery.
type ProjectWebhookReceiver struct{ db store.ProjectWriter }

func NewProjectWebhookReceiver(db store.ProjectWriter) (*ProjectWebhookReceiver, error) {
	if db == nil {
		return nil, errors.New("project webhook receiver requires store")
	}
	return &ProjectWebhookReceiver{db: db}, nil
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
	if err = committed(completion, err); err != nil {
		return "", fmt.Errorf("project webhook receipt: %w", err)
	}
	return result, nil
}
