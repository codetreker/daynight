package store

import (
	"context"

	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// WebhookEligibility is the current owner scope and the actor-visible project name.
type WebhookEligibility struct {
	Status      string
	ProjectName *string
}

// WebhookEligibilityFilter identifies subscriptions affected by a source mutation.
// Exactly one of ProjectID or TeamID is specified. UserID limits the result to
// personal subscriptions; TeamOwner limits it to the shared Team owner.
type WebhookEligibilityFilter struct {
	ProjectID, TeamID, UserID string
	TeamOwner                 bool
}

type WebhookAuthorization struct {
	ID, ProjectID string
	Owner         webhook.Owner
	State         string
	Epoch         int64
}

// WebhookEligibilityDAO is transaction-bound. LockAffected locks only retained
// subscription rows, in ID order. ReadEligibility never takes source locks.
type WebhookEligibilityDAO interface {
	ReadEligibility(context.Context, webhook.Owner, string, string) (WebhookEligibility, error)
	LockAffected(context.Context, WebhookEligibilityFilter) ([]WebhookAuthorization, error)
	Revoke(context.Context, string, int64) error
}
