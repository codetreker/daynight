package worker

import (
	"log/slog"
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	service "github.com/codetreker/daynight/packages/daynight-server/internal/service/worker"
)

// ScopeRoute describes an actual registration and its parsed business variants.
type ScopeRoute struct {
	Pattern    string
	Operations []scopepolicy.Operation
	Dynamic    string
	Fallback   bool
}

type routeClass int

const (
	routeRead routeClass = iota
	routeReadNoHead
	routeConfigure
	routeReport
	routeProduce
	routeProduceNoHead
	routeInspect
	routeReviewRead
	routeLifecycleReport
	routeLifecycleResolve
	routeFallback
)

type routeRegistry struct {
	mux     httpx.RouteRegistrar
	observe func(ScopeRoute)
}

func (r routeRegistry) handle(pattern string, handler http.HandlerFunc, class routeClass) {
	entry := ScopeRoute{Pattern: pattern}
	switch class {
	case routeRead, routeReadNoHead:
		entry.Operations = []scopepolicy.Operation{scopepolicy.WorkerRead}
	case routeConfigure:
		entry.Operations = []scopepolicy.Operation{scopepolicy.WorkerConfigure, scopepolicy.WorkerRead}
	case routeReport:
		entry.Operations = []scopepolicy.Operation{scopepolicy.WorkerReport}
		entry.Dynamic = "report: configuration receipt requires worker:read; actual desired change requires worker:configure; post-commit prompts require prompt:read"
	case routeProduce, routeProduceNoHead:
		entry.Operations = []scopepolicy.Operation{scopepolicy.WorkerReport}
	case routeInspect:
		entry.Operations = []scopepolicy.Operation{scopepolicy.WorkerInspect}
	case routeReviewRead:
		entry.Operations = []scopepolicy.Operation{scopepolicy.WorkerRead, scopepolicy.ProjectRead}
	case routeLifecycleReport:
		entry.Operations = []scopepolicy.Operation{scopepolicy.WorkerReport, scopepolicy.WorkerRead}
	case routeLifecycleResolve:
		entry.Operations = []scopepolicy.Operation{scopepolicy.WorkerRead}
		entry.Dynamic = "resolve: intent requires worker:configure; instance and activation require worker:report"
	case routeFallback:
		entry.Fallback = true
	default:
		panic("unclassified Worker route")
	}
	r.mux.HandleFunc(pattern, handler)
	if r.observe != nil {
		r.observe(entry)
		if strings.HasPrefix(pattern, "GET ") && class != routeReadNoHead && class != routeProduceNoHead {
			entry.Pattern = "HEAD " + strings.TrimPrefix(pattern, "GET ")
			r.observe(entry)
		}
	}
}

// ScopedAuthentication retains the original profile and Origin checks while
// supplying the current credential policy.
type ScopedAuthentication interface {
	RequireScoped(func(http.ResponseWriter, *http.Request, model.CredentialAuthorization)) http.HandlerFunc
}

type scopedAuthentication struct{ ScopedAuthentication }

func (a scopedAuthentication) Require(next httpx.AuthenticatedHandler) http.HandlerFunc {
	return a.RequireScoped(func(w http.ResponseWriter, r *http.Request, auth model.CredentialAuthorization) {
		next(w, r, auth.Principal)
	})
}

// RegisterScopedRoutes uses the existing HTTP protocol with scoped business
// services. Production activation must supply transaction-bound authority readers.
func RegisterScopedRoutes(mux httpx.RouteRegistrar, workers *service.Workers, auth ScopedAuthentication, logger *slog.Logger, observe func(ScopeRoute)) {
	if workers == nil || !workers.ScopesEnabled() || auth == nil {
		panic("scoped Worker service and authentication are required")
	}
	registerRoutesObserved(mux, &workersHandler{workers: workers, logger: logger}, scopedAuthentication{auth}.Require, observe)
}

// RegisterRoutesWithScopeObserver records classifications without enabling scopes.
func RegisterRoutesWithScopeObserver(mux httpx.RouteRegistrar, workers workerService, require func(httpx.AuthenticatedHandler) http.HandlerFunc, logger *slog.Logger, observe func(ScopeRoute)) {
	registerRoutesObserved(mux, &workersHandler{workers: workers, logger: logger}, require, observe)
}
