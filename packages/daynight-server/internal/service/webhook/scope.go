package webhook

import (
	"context"
	"errors"
	"fmt"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopeadmission"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type webhookAuthorizationKey struct{}

// CurrentWebhookAuthorization reads the original credential's policy in the
// same snapshot or write transaction as the protected operation.
type CurrentWebhookAuthorization interface {
	CurrentWebhookAuthorization(context.Context, model.Principal, model.CredentialPolicyProfile) (model.CredentialAuthorization, error)
}

func scopedContext(ctx context.Context, auth model.CredentialAuthorization) (context.Context, error) {
	if err := auth.Validate(); err != nil {
		return ctx, err
	}
	return context.WithValue(ctx, webhookAuthorizationKey{}, auth), nil
}

func requireScope(ctx context.Context, sc store.WebhookReadScope, p model.Principal, ops ...scopepolicy.Operation) error {
	auth, ok := ctx.Value(webhookAuthorizationKey{}).(model.CredentialAuthorization)
	if !ok {
		return nil
	}
	if auth.Principal != p {
		return fmt.Errorf("webhook authorization principal mismatch")
	}
	reader, ok := sc.(CurrentWebhookAuthorization)
	if !ok {
		return fmt.Errorf("webhook transaction cannot recheck credential authorization")
	}
	current, err := reader.CurrentWebhookAuthorization(ctx, p, auth.Profile)
	if errors.Is(err, model.ErrNotFound) {
		return model.Unauthenticated(err)
	}
	if err != nil {
		return err
	}
	if current.Principal != p || current.Profile != auth.Profile {
		return fmt.Errorf("webhook credential authorization changed identity or profile")
	}
	return scopeadmission.Require(current, ops...)
}

func hasScope(ctx context.Context, sc store.WebhookReadScope, p model.Principal, op scopepolicy.Operation) (bool, error) {
	err := requireScope(ctx, sc, p, op)
	var f *model.Fault
	if errors.As(err, &f) && f.Code == "insufficient_scope" {
		return false, nil
	}
	return err == nil, err
}

func (s *Service) MutateAuthorized(ctx context.Context, auth model.CredentialAuthorization, owner Owner, m Mutation) (Result, error) {
	ctx, err := scopedContext(ctx, auth)
	if err != nil {
		return Result{}, err
	}
	return s.Mutate(ctx, auth.Principal, owner, m)
}
func (s *Service) RedeliverAuthorized(ctx context.Context, auth model.CredentialAuthorization, owner Owner, endpoint, delivery string, m Redelivery) (Result, error) {
	ctx, err := scopedContext(ctx, auth)
	if err != nil {
		return Result{}, err
	}
	return s.Redeliver(ctx, auth.Principal, owner, endpoint, delivery, m)
}

func mutationScopeOperations(m Mutation) []scopepolicy.Operation {
	operation := scopepolicy.WebhookWrite
	if m.Kind == "endpoint.delete" {
		operation = scopepolicy.WebhookDelete
	}
	if m.Kind == "signing.rotate" {
		operation = scopepolicy.WebhookSecret
	}
	ops := []scopepolicy.Operation{operation}
	if !m.ReturnReceipt {
		ops = append(ops, scopepolicy.WebhookRead)
	}
	return ops
}
