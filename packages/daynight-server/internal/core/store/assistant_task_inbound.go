package store

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// AssistantTaskInboundWriter runs one inbox receive in a ReadCommitted
// transaction whose readers all observe the same transaction.
type AssistantTaskInboundWriter interface {
	WriteAssistantTaskInbound(context.Context, func(AssistantTaskInboundScope) error) (Completion, error)
}

// AssistantTaskInboundScope binds the assistant task DAO and the read-only
// sources used to verify a Daynight event to the receive transaction.
type AssistantTaskInboundScope interface {
	AssistantTaskScope
	WebhookInboundSources() WebhookInboundSourceReader
	ProjectAccessReader() ProjectAccessReader
}

// WebhookInboundSourceReader reads the captured event and its deliveries
// without locks. A missing event returns ErrWebhookCapturedEventMissing.
type WebhookInboundSourceReader interface {
	WebhookCapturedEventReader
	// PersonalDeliveryDestinations returns one page, up to limit and ordered by
	// delivery ID, of the stored destinations of the event's deliveries whose
	// personal endpoint belongs to owner and whose destination origin equals
	// origin ignoring case. Scheme and host are case-insensitive, and the
	// stored origin keeps the configured case. A non-empty after continues
	// after that delivery ID; a page shorter than limit is the last.
	PersonalDeliveryDestinations(ctx context.Context, eventID, owner, origin, after string, limit int) ([]WebhookDeliveryDestination, error)
}

// WebhookDeliveryDestination is one delivery's stored destination
// configuration and the delivery ID that continues the next page.
type WebhookDeliveryDestination struct {
	DeliveryID    string
	Configuration []byte
}

// ProjectAccessReader evaluates the current project read access of a user. A
// user without access, or a missing project, returns model.ErrNotFound or
// ErrProjectDeleted.
type ProjectAccessReader interface {
	ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error)
}
