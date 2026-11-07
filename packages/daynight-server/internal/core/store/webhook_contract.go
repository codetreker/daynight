package store

import (
	"context"
	"time"

	webhookmodel "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

// WebhookWriter acquires the operation's advisory fence before invoking the
// callback. No owner or source row lock precedes that fence. Scope capabilities
// are valid only inside this ReadCommitted transaction.
type WebhookWriter interface {
	WriteWebhook(context.Context, webhookmodel.Owner, string, func(WebhookWriteScope) error) (Completion, error)
}

type WebhookWriteScope interface {
	CredentialDAO() CredentialReader
	WebhookDAO() WebhookWriteDAO
	ObservedAt(context.Context) (time.Time, error)
}

type WebhookReadDAO interface {
	OwnerAccess(context.Context, webhookmodel.Owner, string) (webhookmodel.OwnerAccess, error)
	Endpoint(context.Context, webhookmodel.Owner, string) (webhookmodel.Endpoint, error)
	Endpoints(context.Context, webhookmodel.Owner, string, WebhookEndpointQuery) (WebhookEndpointPage, error)
	Operation(context.Context, webhookmodel.Owner, string) (webhookmodel.OperationReceipt, error)
	Projects(context.Context, webhookmodel.Owner, string, []string) ([]webhookmodel.ProjectAccess, error)
	Policy(context.Context) (webhookmodel.Policy, error)
}

type WebhookEndpointQuery struct {
	Search  string
	Enabled *bool
	Page    Page
}

type WebhookEndpointPage struct {
	Items   []webhookmodel.Endpoint
	HasMore bool
}

// Expansion locks the sorted Project/ownership/Team/member/grant prefix before
// Endpoint and Subscription rows. Restrictive management locks current owner
// authority and configuration without demanding old Project access.
type WebhookConfigurationLock struct {
	Owner              webhookmodel.Owner
	ActorUserID        string
	EndpointID         string
	ProjectIDs         []string
	RequiredProjectIDs []string
	Expansion          bool
}

type WebhookChangeCost struct {
	Records       int64
	Bytes         int64
	ActiveRecords int64
	ActiveBytes   int64
}

type WebhookWriteDAO interface {
	WebhookReadDAO
	LockConfiguration(context.Context, WebhookConfigurationLock) error
	ReserveOperation(context.Context, webhookmodel.Owner, time.Time) error
	ReserveConfiguration(context.Context, webhookmodel.Owner, WebhookChangeCost) error
	InsertEndpoint(context.Context, webhookmodel.Endpoint) error
	SaveEndpoint(context.Context, webhookmodel.Endpoint, int64) error
	InsertOperation(context.Context, webhookmodel.OperationReceipt) error
}

type WebhookEligibilityChange struct {
	ProjectIDs   []string
	TeamIDs      []string
	UserIDs      []string
	DeletedOwner *webhookmodel.Owner
}

// RefreshAffected locks retained subscriptions in ID order, then reads current
// effective access in a fresh statement. It takes no new owner or source locks
// after subscription locks, and an actual loss advances the persistent epoch.
type WebhookEligibilityDAO interface {
	RefreshAffected(context.Context, WebhookEligibilityChange) error
}
