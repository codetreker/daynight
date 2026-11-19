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
	// PersonalDeliveryDestinations returns, up to limit, the stored destination
	// configuration documents of the event's deliveries whose personal endpoint
	// belongs to owner and whose destination origin is origin.
	PersonalDeliveryDestinations(ctx context.Context, eventID, owner, origin string, limit int) ([][]byte, error)
}

// ProjectAccessReader evaluates the current project read access of a user. A
// user without access, or a missing project, returns model.ErrNotFound or
// ErrProjectDeleted.
type ProjectAccessReader interface {
	ProjectAccess(context.Context, model.Principal, string) (model.ProjectAccess, error)
}
