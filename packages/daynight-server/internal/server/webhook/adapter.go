package webhook

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

// Adapter translates HTTP inputs into the webhook service's domain operations.
type Adapter struct{ Service *webhookservice.Service }

func serviceOwner(o Owner) webhookservice.Owner { return webhookservice.Owner{Kind: o.Kind, ID: o.ID} }
func (a Adapter) List(ctx context.Context, p model.Principal, o Owner, q ListQuery) (any, error) {
	return a.Service.List(ctx, p, serviceOwner(o), webhookservice.ListQuery{Query: q.Query, Enabled: q.Enabled, Limit: q.Limit, Cursor: q.Cursor})
}
func (a Adapter) Get(ctx context.Context, p model.Principal, o Owner, id string) (any, error) {
	return a.Service.Get(ctx, p, serviceOwner(o), id)
}
func (a Adapter) Operation(ctx context.Context, p model.Principal, o Owner, id string) (any, error) {
	return a.Service.Operation(ctx, p, serviceOwner(o), id)
}
func (a Adapter) Secret(ctx context.Context, p model.Principal, o Owner, id string) (any, error) {
	return a.Service.Secret(ctx, p, serviceOwner(o), id)
}
func (a Adapter) Mutate(ctx context.Context, p model.Principal, o Owner, m Mutation) (MutationResult, error) {
	input := webhookservice.Mutation{Kind: m.Kind, EndpointID: m.EndpointID, OperationID: m.OperationID, IssuedAt: m.IssuedAt, ExpectedUserID: m.ExpectedUserID, IfVersion: m.IfVersion, RequestSHA256: m.RequestSHA256, Name: m.Name, Enabled: m.Enabled, HasSubscriptions: m.HasSubscriptions, Mode: m.Mode}
	if m.Destination != nil {
		input.Destination = &webhookservice.Destination{Kind: m.Destination.Kind, AdapterVersion: m.Destination.AdapterVersion, URL: m.Destination.URL}
	}
	result, err := a.Service.Mutate(ctx, p, serviceOwner(o), input)
	return MutationResult{Body: result.Body, Replay: result.Replay}, err
}
