package github

import (
	"context"
	"errors"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

// ErrProjectWebhookSnapshotChanged means a verified delivery used an obsolete configuration.
var ErrProjectWebhookSnapshotChanged = errors.New("project webhook configuration changed")

// ProjectWebhookIdentity binds an authenticated delivery to the verified configuration.
type ProjectWebhookIdentity struct {
	ProjectID             string
	Version, RepositoryID int64
}

type ProjectWebhookReceiptResult string

const (
	ProjectWebhookRejected ProjectWebhookReceiptResult = "rejected"
	ProjectWebhookReceived ProjectWebhookReceiptResult = "received"
	ProjectWebhookEnqueued ProjectWebhookReceiptResult = "enqueued"
)

// RecordProjectWebhook evaluates an already verified delivery in the Project write
// scope for identity.ProjectID. The caller must bind the scope to that Project;
// the scope locks the live Project before the DAO locks its connection.
func RecordProjectWebhook(ctx context.Context, dao store.GitHubProjectWebhookReceiptDAO, identity ProjectWebhookIdentity, event WebhookEvent, requestID string) (ProjectWebhookReceiptResult, error) {
	if dao == nil || strings.TrimSpace(identity.ProjectID) == "" || identity.Version <= 0 || identity.RepositoryID <= 0 || event.RepositoryID <= 0 || strings.TrimSpace(event.DeliveryID) == "" || strings.TrimSpace(requestID) == "" || (event.Kind != "ping" && event.Kind != "pull_request") || (event.Kind == "pull_request" && event.Number <= 0) {
		return "", errors.New("invalid project webhook receipt")
	}
	facts, err := dao.LockReceipt(ctx)
	if err != nil {
		return "", err
	}
	if !facts.Exists || !facts.Enabled || facts.Version == nil || *facts.Version != identity.Version || facts.RepositoryID == nil || *facts.RepositoryID != identity.RepositoryID {
		return "", ErrProjectWebhookSnapshotChanged
	}
	// A retained subscription cannot receive deliveries for a different active binding.
	if event.RepositoryID != identity.RepositoryID || facts.CurrentRepositoryID != nil && *facts.CurrentRepositoryID != identity.RepositoryID {
		return ProjectWebhookRejected, nil
	}
	enqueue := event.Kind == "pull_request" && facts.CurrentRepositoryID != nil && facts.SyncEnabled && facts.BindingValid && facts.AccessAvailable
	if err := dao.RecordReceipt(ctx, store.GitHubProjectWebhookReceiptWrite{Enqueue: enqueue, Number: event.Number, RequestID: requestID, DeliveryID: event.DeliveryID}); err != nil {
		return "", err
	}
	if enqueue {
		return ProjectWebhookEnqueued, nil
	}
	return ProjectWebhookReceived, nil
}
