package store

import (
	"context"
	"time"
)

// WebhookRetentionTransactions runs each bounded history operation independently.
type WebhookRetentionTransactions interface {
	WriteWebhookRetention(context.Context, func(WebhookRetentionScope) error) (Completion, error)
	ObserveWebhookRetention(context.Context, string, string) error
}

// WebhookRetentionScope locks Delivery before Attempts; late writers lock only
// their own Attempt. All mutation counts are actual affected rows.
type WebhookRetentionScope interface {
	ObservedAt(context.Context) (time.Time, error)
	LockRetentionCandidate(context.Context, string, time.Time) (WebhookDelivery, bool, error)
	LockAttempts(context.Context, string) ([]WebhookAttempt, error)
	RetentionSeconds(context.Context, int64) (int, error)
	ExtendRetention(context.Context, string, time.Time, time.Time) (int, error)
	CloseRetention(context.Context, string, time.Time) (int, error)
	DeleteRetentionChildren(context.Context, string, int) (int, error)
	DeleteRetainedDelivery(context.Context, string) (int, error)
	DeleteUnreferencedEvent(context.Context) (string, int, error)
	ClearExpiredEvent(context.Context) (string, int, error)
	RemoveExpiredPayload(context.Context, string, time.Time) (int, error)
}
