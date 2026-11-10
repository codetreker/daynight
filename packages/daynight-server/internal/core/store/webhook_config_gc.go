package store

import (
	"context"
	"time"

	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// WebhookConfigGCCandidate identifies one current configuration record.
type WebhookConfigGCCandidate struct {
	Order                           int
	Kind, ID, EndpointID, ProjectID string
	Owner                           webhook.Owner
	Revision                        int64
}

// WebhookConfigGCScan binds the candidates to the snapshot in which they were
// already retired. Barrier is a PostgreSQL xid8 in decimal form.
type WebhookConfigGCScan struct {
	Barrier    string
	Candidates []WebhookConfigGCCandidate
}

type WebhookConfigGC interface {
	ScanWebhookConfigGC(context.Context, *WebhookConfigGCCandidate, int) (WebhookConfigGCScan, error)
	WebhookConfigGCBarrierPassed(context.Context, string) (bool, error)
	WriteWebhookConfigGC(context.Context, WebhookConfigGCCandidate, func(WebhookConfigGCScope) error) (Completion, error)
	ObserveWebhookConfigGC(context.Context, WebhookConfigGCCandidate) (bool, error)
}

type WebhookConfigGCFacts struct {
	Present, Retired, Referenced bool
	Expiry, ObservedAt           time.Time
}

type WebhookConfigGCScope interface {
	LockConfigCandidate(context.Context, WebhookConfigGCCandidate) (WebhookConfigGCFacts, error)
	DeleteConfigCandidate(context.Context, WebhookConfigGCCandidate) (bool, error)
}
