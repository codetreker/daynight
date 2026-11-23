package usage

import (
	"context"
	"errors"
	"log/slog"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	app "github.com/codetreker/daynight/packages/daynight-server/internal/service/usage"
)

// ScopedAuthentication supplies the authenticated policy snapshot for each
// user-facing usage read. Existing profile and credential binding still apply.
type ScopedAuthentication interface {
	RequireScoped(func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc
}

type scopedReadOperations interface {
	TaskSummariesAuthorized(context.Context, model.CredentialAuthorization, string, []string) (app.Summaries, error)
	TestSummaryAuthorized(context.Context, model.CredentialAuthorization, string) (model.UsageSummary, error)
	RecordsAuthorized(context.Context, model.CredentialAuthorization, string, string, string, app.PageRequest) (app.RecordsPage, error)
	AggregateAuthorized(context.Context, model.CredentialAuthorization, string, string, string, string) (app.Aggregate, error)
}

type scopeContextKey struct{}
type scopedAuthentication struct{ auth ScopedAuthentication }

func (a scopedAuthentication) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return a.auth.RequireScoped(func(w http.ResponseWriter, r *http.Request, authorization model.CredentialAuthorization) {
		ctx := context.WithValue(r.Context(), scopeContextKey{}, authorization)
		next(w, r.WithContext(ctx), authorization.Principal)
	})
}

type scopedOperations struct {
	operations
	reads scopedReadOperations
}

func scopeAuthorization(ctx context.Context, principal model.Principal) (model.CredentialAuthorization, error) {
	authorization, ok := ctx.Value(scopeContextKey{}).(model.CredentialAuthorization)
	if !ok || authorization.Principal != principal {
		return model.CredentialAuthorization{}, errors.New("usage scope authorization missing or mismatched")
	}
	return authorization, nil
}
func (s scopedOperations) TaskSummaries(ctx context.Context, p model.Principal, project string, ids []string) (app.Summaries, error) {
	a, err := scopeAuthorization(ctx, p)
	if err != nil {
		return app.Summaries{}, err
	}
	return s.reads.TaskSummariesAuthorized(ctx, a, project, ids)
}
func (s scopedOperations) TestSummary(ctx context.Context, p model.Principal, id string) (model.UsageSummary, error) {
	a, err := scopeAuthorization(ctx, p)
	if err != nil {
		return model.UsageSummary{}, err
	}
	return s.reads.TestSummaryAuthorized(ctx, a, id)
}
func (s scopedOperations) Records(ctx context.Context, p model.Principal, project, task, session string, input app.PageRequest) (app.RecordsPage, error) {
	a, err := scopeAuthorization(ctx, p)
	if err != nil {
		return app.RecordsPage{}, err
	}
	return s.reads.RecordsAuthorized(ctx, a, project, task, session, input)
}
func (s scopedOperations) Aggregate(ctx context.Context, p model.Principal, project, kind, id, token string) (app.Aggregate, error) {
	a, err := scopeAuthorization(ctx, p)
	if err != nil {
		return app.Aggregate{}, err
	}
	return s.reads.AggregateAuthorized(ctx, a, project, kind, id, token)
}

// RegisterScopedRoutesWithScopeObserver installs scoped user reads while leaving
// usage production, capabilities and dedicated grant authentication unchanged.
func RegisterScopedRoutesWithScopeObserver(mux httpx.RouteRegistrar, service *app.Service, auth Authentication, scopedAuth ScopedAuthentication, logger *slog.Logger, observe func(ScopeRoute)) {
	if service == nil {
		return
	}
	registerScopedRoutes(mux, service, service, auth, scopedAuth, logger, observe)
}

func registerScopedRoutes(mux httpx.RouteRegistrar, service operations, reads scopedReadOperations, auth Authentication, scopedAuth ScopedAuthentication, logger *slog.Logger, observe func(ScopeRoute)) {
	if scopedAuth == nil || reads == nil {
		panic("scoped usage authentication and operations are required")
	}
	registerRoutesObserved(mux, scopedOperations{operations: service, reads: reads}, auth, scopedAuthentication{scopedAuth}, logger, observe)
}
