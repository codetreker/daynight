package store

import (
	"context"
	"errors"
	"time"

	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// WebhookCaptureDAO is bound to the source transaction. FreezeAudience reads
// every match for the batch in one statement snapshot without taking new locks.
// SaveCapture inserts an event and its complete prepared responsibilities; any
// failure must abort the source transaction.
type WebhookCaptureDAO interface {
	FreezeAudience(context.Context, string, []string) ([]WebhookAudience, error)
	RecordedAt(context.Context) (time.Time, error)
	Policy(context.Context, int64) (webhook.Policy, error)
	SaveCapture(context.Context, WebhookCapturedEvent, []WebhookCapturedDelivery) error
}

type WebhookAudience struct {
	EventType, ProjectID, SubscriptionID, BindingID string
	AuthorizationEpoch                              int64
	Endpoint                                        webhook.Endpoint
	ConfigurationSchemaVersion                      int16
}

type WebhookCapturedEvent struct {
	ID, EventType, Source, Subject, ProjectID, TaskID string
	WireVersion, SchemaVersion, FactCodecVersion      int16
	TaskVersion, StepID                               *int64
	TaskDeletedAt                                     *time.Time
	MessageID, OriginRequestID                        *string
	OccurredAt, RecordedAt                            time.Time
	FactBytes, FactSHA256                             []byte
	// Actor is written by SaveCapture and read back only by
	// CapturedEventProvenance; delivery and history reads leave it unknown
	// because outbound rendering never uses it.
	Actor webhook.Actor
}

var ErrWebhookCapturedEventMissing = errors.New("webhook captured event missing")

// WebhookCapturedEventReader reads server-side facts of one captured event by
// its ID. A missing event returns ErrWebhookCapturedEventMissing.
type WebhookCapturedEventReader interface {
	CapturedEventProvenance(context.Context, string) (WebhookCapturedEventProvenance, error)
}

// WebhookCapturedEventProvenance carries the stored actor and the original
// fact digest. FactRemovedAt is set once retention reclaimed the fact bytes;
// the digest remains available after removal.
type WebhookCapturedEventProvenance struct {
	EventID       string
	Actor         webhook.Actor
	FactSHA256    []byte
	FactRemovedAt *time.Time
}

type WebhookCapturedMatch struct {
	SubscriptionID, BindingID, ProjectID, EventType string
	AuthorizationEpoch                              int64
}

type WebhookCapturedDelivery struct {
	ID, EndpointID                                                          string
	Owner                                                                   webhook.Owner
	OriginalMatchSHA256                                                     []byte
	PolicyVersion, DestinationRevision, AdapterVersion                      int64
	DestinationKind, DestinationOrigin                                      string
	RenderVersion, ConfigurationSchemaVersion                               int16
	DestinationConfiguration                                                []byte
	RequestMethod, RequestMediaType                                         string
	DeterministicHeadersJSON, Body, BodySHA256                              []byte
	AutomaticScheduleAt                                                     []time.Time
	AutomaticExpiresAt, PayloadExpiresAt, LastActivityAt, MetadataExpiresAt time.Time
	Matches                                                                 []WebhookCapturedMatch
}
