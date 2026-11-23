package webhook

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// The authorized entry points bind the validated request policy to each read.
// The corresponding reads re-evaluate that policy within their current snapshot.
func (s *Service) CatalogAuthorized(ctx context.Context, auth model.CredentialAuthorization) (any, error) {
	ctx, err := scopedContext(ctx, auth)
	if err != nil {
		return nil, err
	}
	return s.Catalog(ctx, auth.Principal)
}

func (s *Service) ListAuthorized(ctx context.Context, auth model.CredentialAuthorization, o Owner, q ListQuery) (any, error) {
	ctx, err := scopedContext(ctx, auth)
	if err != nil {
		return nil, err
	}
	return s.List(ctx, auth.Principal, o, q)
}

func (s *Service) GetAuthorized(ctx context.Context, auth model.CredentialAuthorization, o Owner, id string) (any, error) {
	ctx, err := scopedContext(ctx, auth)
	if err != nil {
		return nil, err
	}
	return s.Get(ctx, auth.Principal, o, id)
}

func (s *Service) OperationAuthorized(ctx context.Context, auth model.CredentialAuthorization, o Owner, id string) (any, error) {
	ctx, err := scopedContext(ctx, auth)
	if err != nil {
		return nil, err
	}
	return s.Operation(ctx, auth.Principal, o, id)
}

func (s *Service) SecretAuthorized(ctx context.Context, auth model.CredentialAuthorization, o Owner, id string) (any, error) {
	ctx, err := scopedContext(ctx, auth)
	if err != nil {
		return nil, err
	}
	return s.Secret(ctx, auth.Principal, o, id)
}

func (s *Service) GetDeliveryAuthorized(ctx context.Context, auth model.CredentialAuthorization, o Owner, endpoint, id string) (any, error) {
	ctx, err := scopedContext(ctx, auth)
	if err != nil {
		return nil, err
	}
	return s.GetDelivery(ctx, auth.Principal, o, endpoint, id)
}

func (s *Service) PayloadAuthorized(ctx context.Context, auth model.CredentialAuthorization, o Owner, endpoint, id string) (any, error) {
	ctx, err := scopedContext(ctx, auth)
	if err != nil {
		return nil, err
	}
	return s.Payload(ctx, auth.Principal, o, endpoint, id)
}

func (s *Service) ListDeliveriesAuthorized(ctx context.Context, auth model.CredentialAuthorization, o Owner, endpoint string, q DeliveryQuery) (any, error) {
	ctx, err := scopedContext(ctx, auth)
	if err != nil {
		return nil, err
	}
	return s.ListDeliveries(ctx, auth.Principal, o, endpoint, q)
}

func (s *Service) ListAttemptsAuthorized(ctx context.Context, auth model.CredentialAuthorization, o Owner, endpoint, id string, q AttemptQuery) (any, error) {
	ctx, err := scopedContext(ctx, auth)
	if err != nil {
		return nil, err
	}
	return s.ListAttempts(ctx, auth.Principal, o, endpoint, id, q)
}
