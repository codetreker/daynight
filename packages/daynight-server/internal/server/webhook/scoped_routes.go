package webhook

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	webhookservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/webhook"
)

// ScopedAuthentication preserves the authorization from the request's authentication read.
type ScopedAuthentication interface {
	RequireScoped(func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc
}

type scopedAuthorizationKey struct{}
type scopedRouteAuthentication struct {
	auth   ScopedAuthentication
	logger *slog.Logger
}

func (a scopedRouteAuthentication) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return a.auth.RequireScoped(func(w http.ResponseWriter, r *http.Request, auth model.CredentialAuthorization) {
		if err := auth.Validate(); err != nil {
			httpx.WriteError(w, r, a.logger, "webhook", "authentication", model.Unauthenticated(err))
			return
		}
		next(w, r.WithContext(context.WithValue(r.Context(), scopedAuthorizationKey{}, auth)), auth.Principal)
	})
}

func scopedAuthorization(ctx context.Context, p model.Principal) (model.CredentialAuthorization, error) {
	a, ok := ctx.Value(scopedAuthorizationKey{}).(model.CredentialAuthorization)
	if !ok || a.Principal != p {
		return model.CredentialAuthorization{}, model.Unauthenticated(errors.New("missing or mismatched credential authorization"))
	}
	if err := a.Validate(); err != nil {
		return model.CredentialAuthorization{}, model.Unauthenticated(err)
	}
	return a, nil
}

type scopedService interface {
	CatalogAuthorized(context.Context, model.CredentialAuthorization) (any, error)
	ListAuthorized(context.Context, model.CredentialAuthorization, webhookservice.Owner, webhookservice.ListQuery) (any, error)
	GetAuthorized(context.Context, model.CredentialAuthorization, webhookservice.Owner, string) (any, error)
	OperationAuthorized(context.Context, model.CredentialAuthorization, webhookservice.Owner, string) (any, error)
	SecretAuthorized(context.Context, model.CredentialAuthorization, webhookservice.Owner, string) (any, error)
	MutateAuthorized(context.Context, model.CredentialAuthorization, webhookservice.Owner, webhookservice.Mutation) (webhookservice.Result, error)
	ListDeliveriesAuthorized(context.Context, model.CredentialAuthorization, webhookservice.Owner, string, webhookservice.DeliveryQuery) (any, error)
	GetDeliveryAuthorized(context.Context, model.CredentialAuthorization, webhookservice.Owner, string, string) (any, error)
	ListAttemptsAuthorized(context.Context, model.CredentialAuthorization, webhookservice.Owner, string, string, webhookservice.AttemptQuery) (any, error)
	PayloadAuthorized(context.Context, model.CredentialAuthorization, webhookservice.Owner, string, string) (any, error)
	RedeliverAuthorized(context.Context, model.CredentialAuthorization, webhookservice.Owner, string, string, webhookservice.Redelivery) (webhookservice.Result, error)
}

// RegisterScopedRoutes is an explicit assembly entry; legacy registration is unchanged.
func RegisterScopedRoutes(mux httpx.RouteRegistrar, service scopedService, auth ScopedAuthentication, logger *slog.Logger, observers ...func(ScopeRoute)) error {
	if mux == nil || service == nil || auth == nil || logger == nil {
		return errors.New("scoped webhook routes require all dependencies")
	}
	if len(observers) > 1 || (len(observers) == 1 && observers[0] == nil) {
		return errors.New("invalid webhook scope observer")
	}
	var observe func(ScopeRoute)
	if len(observers) == 1 {
		observe = observers[0]
	}
	(&Routes{service: scopedAdapter{service}, auth: scopedRouteAuthentication{auth, logger}, logger: logger}).RegisterRoutesWithScopeObserver(mux, observe)
	return nil
}

type scopedAdapter struct{ service scopedService }

var _ scopedService = (*webhookservice.Service)(nil)

func (s scopedAdapter) Catalog(ctx context.Context, p model.Principal) (any, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.service.CatalogAuthorized(ctx, a)
}
func (s scopedAdapter) List(ctx context.Context, p model.Principal, o Owner, q ListQuery) (any, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.service.ListAuthorized(ctx, a, serviceOwner(o), webhookservice.ListQuery{Query: q.Query, Enabled: q.Enabled, Limit: q.Limit, Cursor: q.Cursor})
}
func (s scopedAdapter) Get(ctx context.Context, p model.Principal, o Owner, id string) (any, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.service.GetAuthorized(ctx, a, serviceOwner(o), id)
}
func (s scopedAdapter) Operation(ctx context.Context, p model.Principal, o Owner, id string) (any, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.service.OperationAuthorized(ctx, a, serviceOwner(o), id)
}
func (s scopedAdapter) Secret(ctx context.Context, p model.Principal, o Owner, id string) (any, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.service.SecretAuthorized(ctx, a, serviceOwner(o), id)
}
func (s scopedAdapter) Mutate(ctx context.Context, p model.Principal, o Owner, m Mutation) (MutationResult, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return MutationResult{}, err
	}
	v, err := s.service.MutateAuthorized(ctx, a, serviceOwner(o), serviceMutation(m))
	return MutationResult{Body: v.Body, Replay: v.Replay}, err
}
func (s scopedAdapter) ListDeliveries(ctx context.Context, p model.Principal, o Owner, endpoint string, q webhookservice.DeliveryQuery) (any, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.service.ListDeliveriesAuthorized(ctx, a, serviceOwner(o), endpoint, q)
}
func (s scopedAdapter) GetDelivery(ctx context.Context, p model.Principal, o Owner, endpoint, delivery string) (any, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.service.GetDeliveryAuthorized(ctx, a, serviceOwner(o), endpoint, delivery)
}
func (s scopedAdapter) ListAttempts(ctx context.Context, p model.Principal, o Owner, endpoint, delivery string, q webhookservice.AttemptQuery) (any, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.service.ListAttemptsAuthorized(ctx, a, serviceOwner(o), endpoint, delivery, q)
}
func (s scopedAdapter) Payload(ctx context.Context, p model.Principal, o Owner, endpoint, delivery string) (any, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return nil, err
	}
	return s.service.PayloadAuthorized(ctx, a, serviceOwner(o), endpoint, delivery)
}
func (s scopedAdapter) Redeliver(ctx context.Context, p model.Principal, o Owner, endpoint, delivery string, m webhookservice.Redelivery) (webhookservice.Result, error) {
	a, err := scopedAuthorization(ctx, p)
	if err != nil {
		return webhookservice.Result{}, err
	}
	return s.service.RedeliverAuthorized(ctx, a, serviceOwner(o), endpoint, delivery, m)
}
