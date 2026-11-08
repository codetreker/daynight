package store

import (
	"context"
	"time"

	webhook "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// WebhookDeliveryTransactions owns bounded, independent delivery transactions.
// A callback's result is usable for network dispatch only after a committed outcome.
type WebhookDeliveryTransactions interface {
	WriteWebhookDelivery(context.Context, func(WebhookDeliveryScope) error) (Completion, error)
}

// WebhookDeliveryScope is transaction-bound. AdmissionSources must precede
// LockDelivery; other operations lock Delivery, Attempts, then Wait. Late writers
// lock only their own Attempt and never acquire a Delivery lock.
type WebhookDeliveryScope interface {
	ObservedAt(context.Context) (time.Time, error)
	Claim(context.Context, int, time.Time, []string) ([]WebhookDelivery, error)
	LockExpired(context.Context, int, time.Time) ([]WebhookDelivery, error)
	LockDueExpiry(context.Context, int, time.Time) ([]WebhookDelivery, error)
	AdmissionSources(context.Context, string, time.Time) (WebhookAdmissionSources, error)
	LockDelivery(context.Context, string) (WebhookDelivery, error)
	TryLockDelivery(context.Context, string) (WebhookDelivery, bool, error)
	LockAttempts(context.Context, string) ([]WebhookAttempt, error)
	LockOwnAttempt(context.Context, string) (WebhookAttempt, error)
	// CurrentDestination is an unlocked observation used to distinguish a
	// missing obsolete wait from a missing current wait.
	CurrentDestination(context.Context, string, int64) (bool, error)
	LockWait(context.Context, string, int64) (WebhookEndpointWait, error)
	InsertAttempt(context.Context, WebhookAttempt) error
	UpdateDelivery(context.Context, WebhookDelivery) error
	UpdateAttempt(context.Context, WebhookAttempt) error
	RaiseWait(context.Context, string, int64, time.Time, time.Time) error
	NextQueueOrder(context.Context) (int64, error)
}

// WebhookRedeliveryScope shares the management operation transaction. Source
// locks, including the actor's current authority, precede Delivery and Attempts.
type WebhookRedeliveryScope interface {
	AdmissionSourcesForActor(context.Context, string, string, webhook.Owner, string, time.Time) (WebhookAdmissionSources, error)
	LockDelivery(context.Context, string) (WebhookDelivery, error)
	LockAttempts(context.Context, string) ([]WebhookAttempt, error)
	UpdateAttempt(context.Context, WebhookAttempt) error
	UpdateDelivery(context.Context, WebhookDelivery) error
	NextQueueOrder(context.Context) (int64, error)
}

// WebhookAdmissionEventError marks a retention decision that waited for a
// Delivery lock. Its caller must reauthorize before returning that decision.
type WebhookAdmissionEventError struct{ Cause error }

func (e *WebhookAdmissionEventError) Error() string { return "webhook admission event unavailable" }
func (e *WebhookAdmissionEventError) Unwrap() error { return e.Cause }

// WebhookDelivery separates immutable capture data from mutable control fields.
// UpdateDelivery writes only the latter.
type WebhookDelivery struct {
	ID, EventID, EndpointID, EventType, ProjectID                                     string
	Owner                                                                             webhook.Owner
	OccurredAt                                                                        time.Time
	OriginalMatchCount                                                                int64
	OriginalMatchSHA256                                                               []byte
	PolicyVersion, DestinationRevision, AdapterVersion                                int64
	DestinationKind, DestinationOrigin                                                string
	RenderVersion, ConfigurationSchemaVersion                                         int16
	DestinationCiphertext                                                             []byte
	RequestMethod, RequestMediaType                                                   string
	DeterministicHeadersJSON, Body, BodySHA256                                        []byte
	OriginalBodyBytes                                                                 int
	PayloadRemovedAt                                                                  *time.Time
	PayloadRemovedReason                                                              *string
	AutomaticScheduleAt                                                               []time.Time
	AutomaticExpiresAt, PayloadExpiresAt                                              time.Time
	AutomaticPlanCursor, AutomaticAttemptCount, ManualOperationCount, AttemptSequence int16
	AutomaticOpen                                                                     bool
	Generation                                                                        int64
	State, Trigger                                                                    string
	ExpiresAt                                                                         time.Time
	NextAttemptAt                                                                     *time.Time
	ManualOperationID, LeaseToken                                                     *string
	LeaseClaimedAt, LeaseUntil                                                        *time.Time
	LeaseGeneration                                                                   *int64
	LeasePlanSlot                                                                     *int16
	CurrentAttemptID                                                                  *string
	TerminalAt                                                                        *time.Time
	LastActivityAt, MetadataExpiresAt                                                 time.Time
	PreparationErrorCode                                                              *string
	QueueOrder                                                                        int64
	PurgingAt                                                                         *time.Time
}

type WebhookAdmissionMatch struct {
	WebhookCapturedMatch
	// Continuous is true only when this original identity and epoch remain active.
	Continuous bool
}

type WebhookAdmissionSources struct {
	Event                                         WebhookCapturedEvent
	Endpoint                                      webhook.Endpoint
	SigningKeys                                   []webhook.SigningKey
	Matches                                       []WebhookAdmissionMatch
	TaskPresent, ProjectEligible, EndpointPresent bool
}

type WebhookEndpointWait struct {
	EndpointID          string
	DestinationRevision int64
	Owner               webhook.Owner
	NotBefore           *time.Time
	UpdatedAt           time.Time
}

type WebhookAttempt struct {
	ID, DeliveryID, EndpointID, Trigger, LeaseToken string
	Generation, DestinationRevision                 int64
	Sequence                                        int16
	SigningKeyIDs                                   []string
	AutomaticPlanSlot                               *int16
	ManualOperationID                               *string
	ClaimedAt, AdmittedAt                           time.Time
	RetentionClosedAt, DispatchedAt, FinishedAt     *time.Time
	Outcome                                         *string
	HTTPStatus                                      *int16
	DurationMS                                      *int64
	ErrorCode                                       *string
	RetryAfterNotBefore                             *time.Time
	RetryAfterDiagnosticCode                        *string
	RecoveredUnknownAt, LateObservedAt              *time.Time
	LateOutcome                                     *string
	LateHTTPStatus                                  *int16
	LateDurationMS                                  *int64
	LateErrorCode                                   *string
	LateRetryAfterNotBefore                         *time.Time
	LateRetryAfterDiagnosticCode                    *string
}

// WebhookHistoryRetained applies the logical metadata deadline after locking
// Delivery and Attempts, including activity that has not updated its candidate
// deadline yet. A closed history never reopens on a late observation.
func WebhookHistoryRetained(d WebhookDelivery, attempts []WebhookAttempt, now time.Time) bool {
	if d.PurgingAt != nil {
		return false
	}
	if d.MetadataExpiresAt.After(now) || (d.State == "pending" && d.ExpiresAt.After(now)) || (d.State == "leased" && d.LeaseUntil != nil && d.LeaseUntil.After(now)) {
		return true
	}
	for _, a := range attempts {
		if (a.FinishedAt != nil && a.FinishedAt.Add(30*24*time.Hour).After(now)) || (a.LateObservedAt != nil && a.LateObservedAt.Add(30*24*time.Hour).After(now)) {
			return true
		}
	}
	return false
}
