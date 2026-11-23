package github

import (
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// ScopeRoute records the declared classification of an actual registration.
// A fallback handles unsupported methods; the webhook uses its own signature.
type ScopeRoute struct {
	Pattern            string
	Operations         []scopepolicy.Operation
	Fallback           bool
	IndependentProfile bool
}

type routeClass int

const (
	routeRead routeClass = iota
	routeProjectRead
	routeManage
	routeReadManage
	routeFallback
	routeWebhook
)

type RouteRegistry struct {
	mux     httpx.RouteRegistrar
	observe func(ScopeRoute)
}

func NewRouteRegistry(mux httpx.RouteRegistrar, observe func(ScopeRoute)) *RouteRegistry {
	return &RouteRegistry{mux: mux, observe: observe}
}
func (r *RouteRegistry) handle(pattern string, handler http.HandlerFunc, class routeClass) {
	var entry ScopeRoute
	entry.Pattern = pattern
	switch class {
	case routeRead:
		entry.Operations = []scopepolicy.Operation{scopepolicy.GithubRead}
	case routeProjectRead:
		entry.Operations = []scopepolicy.Operation{scopepolicy.ProjectRead}
	case routeManage:
		entry.Operations = []scopepolicy.Operation{scopepolicy.GithubManage}
	case routeReadManage:
		entry.Operations = []scopepolicy.Operation{scopepolicy.GithubRead, scopepolicy.GithubManage}
	case routeFallback:
		entry.Fallback = true
	case routeWebhook:
		entry.IndependentProfile = true
	default:
		panic("unclassified GitHub route")
	}
	r.mux.HandleFunc(pattern, handler)
	if r.observe != nil {
		r.observe(entry)
		if strings.HasPrefix(pattern, "GET ") {
			entry.Pattern = "HEAD " + strings.TrimPrefix(pattern, "GET ")
			r.observe(entry)
		}
	}
}
