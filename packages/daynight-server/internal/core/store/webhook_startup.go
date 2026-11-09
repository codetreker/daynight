package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// WebhookStartupReader supplies the persisted policy and relationship checks
// required before the application can expose webhook management or dispatch.
type WebhookStartupReader interface {
	WebhookStartupPolicies(context.Context) ([]model.Policy, error)
	CheckWebhookCurrentReferences(context.Context) error
}
