package store

import (
	"context"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// WebhookTransactions isolates operation fencing and subsequent current views.
type WebhookTransactions interface {
	WriteWebhook(context.Context, webhook.Owner, string, func(WebhookWriteScope) error) (Completion, error)
	ReadWebhookSnapshot(context.Context, func(WebhookReadScope) error) error
}

type WebhookReadScope interface {
	CredentialDAO() CredentialReader
	TeamDAO() TeamReader
	WebhookDAO() WebhookReader
	ObservedAt(context.Context) (time.Time, error)
}

type WebhookWriteScope interface {
	WebhookReadScope
	WebhookWriter() WebhookWriter
	// LockAuthority takes the Team root and relationship locks for an owner.
	// Personal authority is checked against the principal by the caller.
	LockAuthority(context.Context, webhook.Owner, string) error
	// LockCredential must be called after waiting on other locks before applying a new effect.
	LockCredential(context.Context, model.Principal) (ThreadCredential, error)
}

type WebhookReader interface {
	Endpoint(context.Context, webhook.Owner, string) (webhook.Endpoint, error)
	Endpoints(context.Context, webhook.Owner) ([]webhook.Endpoint, error)
	SigningKeys(context.Context, string) ([]webhook.SigningKey, error)
	Operation(context.Context, webhook.Owner, string) (webhook.Operation, error)
	Policy(context.Context, int64) (webhook.Policy, error)
}

type WebhookWriter interface {
	WebhookReader
	LockEndpoint(context.Context, webhook.Owner, string) (webhook.Endpoint, error)
	PutEndpoint(context.Context, webhook.Endpoint) error
	PutSigningKey(context.Context, webhook.SigningKey) error
	DeleteSigningKeys(context.Context, string) error
	PutOperation(context.Context, webhook.Operation) error
}
