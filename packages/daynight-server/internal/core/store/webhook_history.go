package store

import (
	"context"
	"errors"
	"time"

	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

var ErrWebhookHistoryEventMissing = errors.New("webhook history event missing")

// WebhookHistoryReader reads retained history within the caller's snapshot.
// A missing reader is an error, never an empty history.
type WebhookHistoryReader interface {
	HistoryBatch(context.Context, webhook.Owner, string, string, time.Time, string, int) (WebhookHistoryBatch, error)
	HistoryMatches(context.Context, []string) ([]WebhookHistoryMatch, error)
	HistoryBatchAttempts(context.Context, []string) ([]WebhookAttempt, error)
	HistoryDeliveries(context.Context, webhook.Owner, string, time.Time, string, int) ([]WebhookDelivery, error)
	HistoryDelivery(context.Context, webhook.Owner, string, string) (WebhookDelivery, error)
	HistorySources(context.Context, WebhookDelivery, string) (WebhookHistorySources, error)
	HistoryDisclosure(context.Context, webhook.Owner, string, string, time.Time) (string, error)
	HistoryAttempts(context.Context, string) ([]WebhookAttempt, error)
	LatestAttempt(context.Context, string) (*WebhookAttempt, error)
}

type WebhookHistorySources struct {
	Event             WebhookCapturedEvent
	Matches           []WebhookAdmissionMatch
	TaskPresent       bool
	ProjectReadable   bool
	OriginalFactBytes int
	FactRemovedAt     *time.Time
	TaskTitle         *string
}

// WebhookHistoryBatch uses one database statement time for its candidate projections.
// Items remain in the history keyset order, including missing original events.
type WebhookHistoryBatch struct {
	ObservedAt time.Time
	Items      []WebhookHistoryItem
}

type WebhookHistoryItem struct {
	Delivery          WebhookDelivery
	Sources           WebhookHistorySources
	EventPresent      bool
	Eligibility       webhook.EligibilityFacts
	EndpointPresent   bool
	EndpointDeletedAt *time.Time
	EndpointRevision  *int64
}

type WebhookHistoryMatch struct {
	DeliveryID string
	WebhookAdmissionMatch
}
